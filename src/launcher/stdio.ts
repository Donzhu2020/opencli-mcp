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
    await proxyToHost({ host: state.host, port: state.port, token: state.token }, opts.version, log);
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

async function proxyToHost(initial: { host: string; port: number; token: string }, version: string, log: (m: string) => void): Promise<void> {
  // The Chrome-spawned host restarts whenever the extension's Native port drops — an extension reload, a crash, or the
  // service worker being replaced. When that happens we must NOT kill the client's stdio channel (Codex/Claude don't
  // auto-reconnect a dead MCP server); we keep the stdio server up and reconnect to the host on demand, re-reading the
  // host state (its port/token can change across restarts).
  let client: Client | null = null;
  let clientGen = 0;
  let server!: Server; // constructed after peeking the host's instructions (below); wire()/connectOnce() only run after that
  const wire = (c: Client): void => {
    c.setNotificationHandler('notifications/tools/list_changed', async () => { await server.sendToolListChanged().catch(() => {}); });
    c.setNotificationHandler('notifications/resources/list_changed', async () => { await server.sendResourceListChanged().catch(() => {}); });
    c.setNotificationHandler('notifications/prompts/list_changed', async () => { await server.sendPromptListChanged().catch(() => {}); });
    c.setNotificationHandler('notifications/message', async (n) => { await server.sendLoggingMessage(n.params).catch(() => {}); });
  };
  const connectOnce = async (): Promise<Client> => {
    // Re-resolve the host each time: an extension reload spawns a fresh host with a new port/token (state file rewritten).
    const st = readHostState();
    if (!st) throw new Error('host not running');
    const h = await hostHealth(st);
    if (!h.ok) throw new Error('error' in h ? h.error : 'host not running');
    const c = new Client({ name: 'opencli-mcp-stdio', version }, { capabilities: {} });
    const up = new StreamableHTTPClientTransport(new URL(`http://${st.host}:${st.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${st.token}` } } });
    const gen = ++clientGen;
    up.onclose = () => { if (gen === clientGen) { client = null; log('host connection closed; will reconnect on next request'); } };
    up.onerror = () => { /* surfaced when a request fails; reconnect handles it */ };
    await c.connect(up);
    wire(c);
    client = c;
    return c;
  };
  let connecting: Promise<Client> | null = null;
  const ensure = async (): Promise<Client> => {
    if (client) return client;
    if (!connecting) connecting = connectOnce().finally(() => { connecting = null; });
    return connecting;
  };
  const isDisconnect = (err: unknown): boolean => /closed|ECONNREFUSED|ECONNRESET|fetch failed|not connected|terminated/i.test(String((err as Error)?.message ?? err));
  // Run an upstream call; on a disconnect, drop the client and retry once (reconnect to a possibly-restarted host).
  const via = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
    try { return await fn(await ensure()); }
    catch (err) { if (!isDisconnect(err)) throw err; client = null; return fn(await ensure()); }
  };
  const hostDownError = (err: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: { code: 'host_unavailable', message: `opencli-mcp host not reachable: ${String((err as Error)?.message ?? err)}`, hint: 'The Chrome extension/host restarted (e.g. an extension reload) or is asleep. Wake Chrome and retry; run doctor to confirm.', retryable: true } }) }], isError: true });

  // Peek the host's instructions with a short-lived client so the stdio Server can advertise them at construction
  // (instructions travel in the initialize response), then hand off to the managed, reconnectable client.
  const peek = new Client({ name: 'opencli-mcp-stdio', version }, { capabilities: {} });
  const peekUp = new StreamableHTTPClientTransport(new URL(`http://${initial.host}:${initial.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${initial.token}` } } });
  await peek.connect(peekUp);
  const instructions = peek.getInstructions();
  await peek.close().catch(() => {});
  server = new Server({ name: 'opencli-mcp', version }, {
    capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true }, logging: {} },
    ...(instructions ? { instructions } : {}),
  });
  await ensure(); // open the managed client the handlers proxy through

  server.setRequestHandler('tools/list', async (r) => via((c) => c.listTools(r.params)));
  // Long browser ops can run up to 30 min. Forward the client's progress token and abort signal so the host's progress
  // notifications reach the client and client cancellation stops the host call. A dropped host returns a retryable
  // host_unavailable result (not a dead channel), so the client can simply retry once Chrome is back.
  server.setRequestHandler('tools/call', async (r, ctx) => {
    const progressToken = (r.params as { _meta?: { progressToken?: string | number } })._meta?.progressToken;
    const call = (c: Client) => c.callTool(r.params, {
      timeout: 1_800_000,
      resetTimeoutOnProgress: true,
      signal: ctx.mcpReq.signal,
      ...(progressToken !== undefined
        ? { onprogress: (p) => { void ctx.mcpReq.notify({ method: 'notifications/progress', params: { ...p, progressToken } }); } }
        : {}),
    });
    try { return await via(call); } catch (err) { if (isDisconnect(err)) return hostDownError(err); throw err; }
  });
  server.setRequestHandler('resources/list', async (r) => via((c) => c.listResources(r.params)));
  server.setRequestHandler('resources/templates/list', async (r) => via((c) => c.listResourceTemplates(r.params)));
  server.setRequestHandler('resources/read', async (r) => via((c) => c.readResource(r.params)));
  server.setRequestHandler('prompts/list', async (r) => via((c) => c.listPrompts(r.params)));
  server.setRequestHandler('prompts/get', async (r) => via((c) => c.getPrompt(r.params)));

  const transport = new StdioServerTransport();
  let closing = false;
  const bye = (why: string): void => {
    if (closing) return; closing = true;
    log(why);
    transport.onclose = undefined;
    void (client?.close().catch(() => {}) ?? Promise.resolve()).finally(() => process.exit(0));
  };
  // Only the client (Codex/Claude) going away ends the launcher — never a host drop.
  transport.onclose = () => bye('stdio closed');
  process.stdin.once('end', () => bye('stdin ended'));
  await server.connect(transport);
}
