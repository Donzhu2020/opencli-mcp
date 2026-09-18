/**
 * stdio launcher for local MCP hosts (Claude Code, Cursor, Codex, …).
 * If the Chrome-spawned host is running, proxy to it (shared browser runtime). Otherwise embed a
 * runtime in-process: site commands with strategy `public` work; browsing needs Chrome + the extension.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
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
  log(`host not running (${'error' in health ? health.error : 'embedded mode'}): embedded runtime; browsing needs Chrome + the extension`);
  const config = readConfig();
  const rt = new Runtime({ cursor: config.cursor ?? true, sites: config.sites, sitesWrite: config.sitesWrite, log });
  await rt.init();
  const session = createMcpServer(rt, 'stdio', { version: opts.version });
  const transport = new StdioServerTransport();
  await session.server.connect(transport);
  let closing = false;
  const bye = (): void => { if (closing) return; closing = true; void session.close().catch(() => {}).then(() => rt.shutdown()).catch(() => {}).finally(() => process.exit(0)); };
  transport.onclose = bye;
  process.stdin.once('end', bye);
}

async function proxyToHost(host: string, port: number, token: string, version: string, log: (m: string) => void): Promise<void> {
  const client = new Client({ name: 'opencli-mcp-stdio', version }, { capabilities: {} });
  const upstream = new StreamableHTTPClientTransport(new URL(`http://${host}:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(upstream);
  const server = new Server({ name: 'opencli-mcp', version }, {
    capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true }, logging: {} },
    instructions: client.getInstructions(),
  });
  server.setRequestHandler('tools/list', async (r) => client.listTools(r.params));
  // long browser ops can run up to 30 min; progress/cancellation forwarding is handled by the transport in 2026-07-28
  server.setRequestHandler('tools/call', async (r) => client.callTool(r.params, { timeout: 1_800_000, resetTimeoutOnProgress: true }));
  server.setRequestHandler('resources/list', async (r) => client.listResources(r.params));
  server.setRequestHandler('resources/templates/list', async (r) => client.listResourceTemplates(r.params));
  server.setRequestHandler('resources/read', async (r) => client.readResource(r.params));
  server.setRequestHandler('prompts/list', async (r) => client.listPrompts(r.params));
  server.setRequestHandler('prompts/get', async (r) => client.getPrompt(r.params));
  client.setNotificationHandler('notifications/tools/list_changed', async () => { await server.sendToolListChanged(); });
  client.setNotificationHandler('notifications/resources/list_changed', async () => { await server.sendResourceListChanged(); });
  client.setNotificationHandler('notifications/prompts/list_changed', async () => { await server.sendPromptListChanged(); });
  client.setNotificationHandler('notifications/message', async (n) => { await server.sendLoggingMessage(n.params); });
  const transport = new StdioServerTransport();
  let closing = false;
  const bye = (why: string): void => {
    if (closing) return; closing = true;
    log(why);
    upstream.onclose = undefined; upstream.onerror = undefined; transport.onclose = undefined;
    void client.close().catch(() => {}).finally(() => process.exit(0));
  };
  transport.onclose = () => bye('stdio closed');
  process.stdin.once('end', () => bye('stdin ended'));
  upstream.onclose = () => bye('host connection closed');
  upstream.onerror = (err: Error) => { if (/ECONNREFUSED|ECONNRESET|fetch failed/i.test(String(err))) bye(`host unreachable: ${err.message}`); else log(`upstream error: ${err.message}`); };
  await server.connect(transport);
}
