/**
 * The Chrome-spawned native host: Native Messaging on stdio ⇄ extension, MCP over loopback HTTP.
 * Lives exactly as long as the extension keeps its port open (Chrome's contract) — so the bridge,
 * the port and the debugger attach stay warm together.
 */
import { Writable } from 'node:stream';
import { NativeChannel } from './native-messaging.js';
import { ExtensionBridge } from './bridge.js';
import { Runtime } from '../runtime/runtime.js';
import { startHttpServer, type HttpServerHandle } from './http.js';
import { DEFAULT_REMOTE_PORT, SOCKET_PATH, clearHostState, loadOrCreateToken, readConfig, writeHostState, type HostState } from './state.js';

export async function runNativeHost(opts: { version: string }): Promise<void> {
  const log = (m: string): void => { process.stderr.write(`[opencli-mcp host] ${m}\n`); };
  // stdout belongs to Native Messaging: route every other stdout write (console.log, library logs) to stderr
  const rawWrite = process.stdout.write.bind(process.stdout);
  const frames = new Writable({ write(chunk, _enc, cb) { rawWrite(chunk as Buffer, cb); } });
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => (process.stderr.write as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
  const channel = new NativeChannel(process.stdin, frames);
  const bridge = new ExtensionBridge(channel);
  const config = readConfig();
  const rt = new Runtime({ bridge, cursor: config.cursor ?? true, sites: config.sites, sitesWrite: config.sitesWrite, log });
  await rt.init();
  const local = await startHttpServer(rt, { listen: { path: SOCKET_PATH }, version: opts.version });
  // remote access (cloud agents through a tunnel) is a second consumer, off unless configured: TCP + bearer token
  let remote: HostState['remote']; let remoteServer: HttpServerHandle | undefined;
  if (config.remote) {
    const token = loadOrCreateToken();
    const port = config.remote.port ?? DEFAULT_REMOTE_PORT; const host = config.remote.host ?? '127.0.0.1';
    try { remoteServer = await startHttpServer(rt, { listen: { port, host }, token, version: opts.version }); remote = { host, port: remoteServer.port!, token }; }
    catch (err) { log(`remote port ${port} unavailable (${(err as Error).message}); remote access disabled`); }
  }
  bridge.ready = { version: opts.version, endpoint: local.endpoint };
  const state = (): HostState => ({ pid: process.pid, socket: local.endpoint, ...(remote && { remote }), startedAt: rt.startedAt, extensionVersion: bridge.extensionVersion, contextId: bridge.contextId, version: opts.version });
  bridge.on('hello', (h) => { log(`extension ${h.extensionVersion} connected (protocol ${h.protocolVersion})`); writeHostState(state()); });
  if (bridge.connected) { bridge.sendReady(); writeHostState(state()); log(`extension ${bridge.extensionVersion} connected before startup finished`); }
  log(`listening on ${local.endpoint}${remote ? ` and http://${remote.host}:${remote.port}/mcp (bearer)` : ''}`);

  let closing = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return; closing = true;
    log(`shutting down (${reason})`);
    await rt.shutdown().catch(() => {});
    await local.close().catch(() => {});
    if (remote) await remoteServer?.close().catch(() => {});
    clearHostState(process.pid);
    process.exit(0);
  };
  channel.on('error', (err) => log(`channel error: ${err.message}`));
  channel.on('close', () => void shutdown('extension port closed'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => { log(`uncaught: ${err.stack ?? err}`); void shutdown('uncaught exception'); });
  process.on('unhandledRejection', (err) => log(`unhandled: ${(err as Error)?.stack ?? err}`));
}
