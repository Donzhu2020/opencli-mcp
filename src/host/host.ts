/**
 * The Chrome-spawned native host: Native Messaging on stdio ⇄ extension, MCP over loopback HTTP.
 * Lives exactly as long as the extension keeps its port open (Chrome's contract) — so the bridge,
 * the port and the debugger attach stay warm together.
 */
import { NativeChannel } from './native-messaging.js';
import { ExtensionBridge } from './bridge.js';
import { Runtime } from '../runtime/runtime.js';
import { startHttpServer } from './http.js';
import { DEFAULT_PORT, clearHostState, loadOrCreateToken, readConfig, writeHostState } from './state.js';

export async function runNativeHost(opts: { version: string }): Promise<void> {
  const log = (m: string): void => { process.stderr.write(`[opencli-mcp host] ${m}\n`); };
  // stdout belongs to Native Messaging: silence anything that would corrupt frames
  (console as unknown as { log: unknown }).log = (...a: unknown[]) => log(a.map(String).join(' '));
  const channel = new NativeChannel(process.stdin, process.stdout);
  const bridge = new ExtensionBridge(channel);
  const config = readConfig();
  const rt = new Runtime({ bridge, cursor: config.cursor ?? true, cdpEndpoint: config.cdpEndpoint, log });
  await rt.init();
  const token = loadOrCreateToken();
  let http;
  try { http = await startHttpServer(rt, { port: config.port ?? DEFAULT_PORT, token, version: opts.version }); }
  catch (err) { log(`port ${config.port ?? DEFAULT_PORT} busy (${(err as Error).message}); using a random port`); http = await startHttpServer(rt, { port: 0, token, version: opts.version }); }
  const state = () => ({ pid: process.pid, port: http.port, host: http.host, token, startedAt: rt.startedAt, extensionVersion: bridge.extensionVersion, contextId: bridge.contextId, version: opts.version });
  writeHostState(state());
  bridge.on('hello', (h) => { log(`extension ${h.extensionVersion} connected (protocol ${h.protocolVersion})`); writeHostState(state()); });
  rt.on('browser-event', (e) => log(`event ${e.kind}`));
  log(`listening on http://${http.host}:${http.port}/mcp`);

  let closing = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return; closing = true;
    log(`shutting down (${reason})`);
    await rt.shutdown().catch(() => {});
    await http.close().catch(() => {});
    clearHostState(process.pid);
    process.exit(0);
  };
  channel.on('close', () => void shutdown('extension port closed'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => log(`uncaught: ${err.stack ?? err}`));
  process.on('unhandledRejection', (err) => log(`unhandled: ${(err as Error)?.stack ?? err}`));
}
