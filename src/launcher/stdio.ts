/**
 * stdio launcher for local MCP hosts (Claude Code, Cursor, …).
 * If the Chrome-spawned host is running, proxy to it (shared browser runtime). Otherwise embed a
 * runtime in-process: site commands with strategy `public` work, and a CDP endpoint (Electron /
 * remote Chrome) can be driven; extension-backed browsing needs Chrome + the extension.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourceTemplatesRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema,
  ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema, PromptListChangedNotificationSchema, LoggingMessageNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Runtime } from '../runtime/runtime.js';
import { createMcpServer } from '../mcp/server.js';
import { hostHealth, readConfig, readHostState } from '../host/state.js';

export async function runStdio(opts: { version: string; forceEmbedded?: boolean }): Promise<void> {
  const log = (m: string): void => { process.stderr.write(`[opencli-mcp] ${m}\n`); };
  const state = readHostState();
  const health = opts.forceEmbedded ? { ok: false } : await hostHealth(state);
  if (state && health.ok) {
    log(`proxying to host on port ${state.port} (backend ${health.backend})`);
    await proxyToHost(state.host, state.port, state.token, opts.version, log);
    return;
  }
  log(`host not running (${'error' in health ? health.error : 'embedded mode'}): embedded runtime; browser needs Chrome + extension or OPENCLI_CDP_ENDPOINT`);
  const config = readConfig();
  const rt = new Runtime({ cdpEndpoint: config.cdpEndpoint, cursor: config.cursor ?? true, log });
  await rt.init();
  const session = createMcpServer(rt, 'stdio', { version: opts.version });
  for (const site of config.sites ?? []) rt.session('stdio').enabledSites.set(site, { write: (config.sitesWrite ?? []).includes(site) });
  const transport = new StdioServerTransport();
  await session.server.connect(transport);
  if ((config.sites ?? []).length) rt.emit('tools-changed', {});
  transport.onclose = () => { void session.close().then(() => rt.shutdown()).finally(() => process.exit(0)); };
}

async function proxyToHost(host: string, port: number, token: string, version: string, log: (m: string) => void): Promise<void> {
  const client = new Client({ name: 'opencli-mcp-stdio', version }, { capabilities: {} });
  const upstream = new StreamableHTTPClientTransport(new URL(`http://${host}:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(upstream);
  const server = new Server({ name: 'opencli-mcp', version }, {
    capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true }, logging: {} },
    instructions: client.getInstructions(),
  });
  server.setRequestHandler(ListToolsRequestSchema, async (r) => client.listTools(r.params));
  server.setRequestHandler(CallToolRequestSchema, async (r) => client.callTool(r.params) as Promise<Record<string, unknown>>);
  server.setRequestHandler(ListResourcesRequestSchema, async (r) => client.listResources(r.params));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (r) => client.listResourceTemplates(r.params));
  server.setRequestHandler(ReadResourceRequestSchema, async (r) => client.readResource(r.params));
  server.setRequestHandler(ListPromptsRequestSchema, async (r) => client.listPrompts(r.params));
  server.setRequestHandler(GetPromptRequestSchema, async (r) => client.getPrompt(r.params));
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { await server.sendToolListChanged(); });
  client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => { await server.sendResourceListChanged(); });
  client.setNotificationHandler(PromptListChangedNotificationSchema, async () => { await server.sendPromptListChanged(); });
  client.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => { await server.sendLoggingMessage(n.params); });
  const transport = new StdioServerTransport();
  transport.onclose = () => { void client.close().finally(() => process.exit(0)); };
  upstream.onclose = () => { log('host connection closed'); void transport.close().finally(() => process.exit(0)); };
  await server.connect(transport);
}
