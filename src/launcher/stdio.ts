/**
 * stdio launcher for local MCP hosts (Claude Code, Cursor, …).
 * If the Chrome-spawned host is running, proxy to it (shared browser runtime). Otherwise embed a
 * runtime in-process: site commands with strategy `public` work; browsing needs Chrome + the extension.
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
import { hostHealth, readConfig, readHostState, socketFetch, LOCAL_MCP_URL } from '../host/state.js';

export async function runStdio(opts: { version: string; forceEmbedded?: boolean }): Promise<void> {
  const log = (m: string): void => { process.stderr.write(`[opencli-mcp] ${m}\n`); };
  const state = readHostState();
  const health = opts.forceEmbedded ? { ok: false } : await hostHealth(state);
  if (state && health.ok) {
    log(`proxying to host at ${state.socket} (backend ${health.backend})`);
    await proxyToHost(state.socket, opts.version, log);
    return;
  }
  log(`host not running (${'error' in health ? health.error : 'embedded mode'}): embedded runtime; browsing needs Chrome + the extension`);
  const config = readConfig();
  const rt = new Runtime({ cursor: config.cursor ?? true, sites: config.sites, sitesWrite: config.sitesWrite, log });
  await rt.init();
  const session = createMcpServer(rt, 'stdio', { version: opts.version });
  const transport = new StdioServerTransport();
  await session.server.connect(transport);
  let closing = false;
  const bye = () => { if (closing) return; closing = true; void session.close().catch(() => {}).then(() => rt.shutdown()).catch(() => {}).finally(() => process.exit(0)); };
  transport.onclose = bye;
  process.stdin.once('end', bye);
}

async function proxyToHost(socket: string, version: string, log: (m: string) => void): Promise<void> {
  const client = new Client({ name: 'opencli-mcp-stdio', version }, { capabilities: {} });
  // the same Streamable HTTP protocol, carried by the local socket instead of a TCP port
  const upstream = new StreamableHTTPClientTransport(new URL(LOCAL_MCP_URL), { fetch: socketFetch(socket) as unknown as typeof fetch });
  await client.connect(upstream);
  const server = new Server({ name: 'opencli-mcp', version }, {
    capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true }, logging: {} },
    instructions: client.getInstructions(),
  });
  server.setRequestHandler(ListToolsRequestSchema, async (r) => client.listTools(r.params));
  server.setRequestHandler(CallToolRequestSchema, async (r, extra) => {
    const token = r.params._meta?.progressToken;
    return client.callTool(r.params, undefined, {
      signal: extra.signal,
      timeout: 1_800_000,
      resetTimeoutOnProgress: true,
      ...(token !== undefined && { onprogress: (p) => { void extra.sendNotification({ method: 'notifications/progress', params: { ...p, progressToken: token } }).catch(() => {}); } }),
    }) as Promise<Record<string, unknown>>;
  });
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
  let closing = false;
  const bye = (why: string) => {
    if (closing) return; closing = true;
    log(why);
    // detach the close callbacks first: client.close() closes the transport, which would re-enter bye()
    upstream.onclose = undefined; upstream.onerror = undefined; transport.onclose = undefined;
    void client.close().catch(() => {}).finally(() => process.exit(0));
  };
  transport.onclose = () => bye('stdio closed');
  process.stdin.once('end', () => bye('stdin ended'));
  upstream.onclose = () => bye('host connection closed');
  upstream.onerror = (err) => { if (/ECONNREFUSED|ECONNRESET|fetch failed/i.test(String(err))) bye(`host unreachable: ${err.message}`); else log(`upstream error: ${err.message}`); };
  await server.connect(transport);
}
