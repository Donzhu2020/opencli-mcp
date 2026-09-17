/**
 * NativeHost — the extension's end of the Native Messaging port. Chrome spawns the host when we
 * connect; while the port is open Chrome keeps this service worker alive and the host keeps the
 * runtime warm. Reconnect immediately on disconnect (backoff) with an alarm as the safety net.
 */
import type { Command, ExtToHost, HostToExt, Result, BrowserEvent } from '../../src/protocol.js';
import { NATIVE_HOST_NAME, PROTOCOL_VERSION } from '../../src/protocol.js';

const RECONNECT_ALARM = 'opencli-mcp-reconnect';
const CONTEXT_KEY = 'opencli_mcp_context_id';

export class NativeHost {
  private port: chrome.runtime.Port | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' = 'disconnected';
  lastError: string | null = null;

  constructor(private readonly onCommand: (cmd: Command) => Promise<Result>, private readonly application = NATIVE_HOST_NAME) {
    chrome.alarms.onAlarm.addListener((a) => { if (a.name === RECONNECT_ALARM && !this.port) this.connect(); });
  }

  get connected(): boolean { return this.port !== null && this.status === 'connected'; }

  async contextId(): Promise<string> {
    const stored = await chrome.storage.local.get(CONTEXT_KEY);
    const existing = stored?.[CONTEXT_KEY] as string | undefined;
    if (existing) return existing;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [CONTEXT_KEY]: id });
    return id;
  }

  connect(): boolean {
    if (this.port) return true;
    this.status = this.attempt > 0 ? 'reconnecting' : 'connecting';
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(this.application);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.status = 'disconnected';
      this.scheduleReconnect();
      return false;
    }
    this.port = port;
    port.onMessage.addListener((msg: HostToExt) => { void this.handle(msg); });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message ?? null;
      this.lastError = err;
      this.port = null;
      this.status = 'disconnected';
      console.warn('[opencli-mcp] native host disconnected', err ?? '');
      this.scheduleReconnect();
    });
    this.status = 'connected';
    this.attempt = 0;
    chrome.alarms.clear(RECONNECT_ALARM);
    void this.contextId().then((contextId) => this.send({ type: 'hello', extensionVersion: chrome.runtime.getManifest().version, protocolVersion: PROTOCOL_VERSION, contextId }));
    console.log('[opencli-mcp] native host connected');
    return true;
  }

  private scheduleReconnect(): void {
    if (this.timer) return;
    const delay = Math.min(5000, 500 * 2 ** Math.min(this.attempt, 4));
    this.attempt++;
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, delay);
    // alarms survive service-worker restarts; chrome allows >= 30s periods
    chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
  }

  send(msg: ExtToHost): void {
    if (!this.port) return;
    try { this.port.postMessage(msg); } catch (err) { console.warn('[opencli-mcp] postMessage failed', err); }
  }
  event(event: BrowserEvent): void { this.send({ type: 'event', event }); }

  private async handle(msg: HostToExt): Promise<void> {
    if (!msg || msg.type !== 'command') return;
    const cmd = msg.command;
    let result: Result;
    try { result = await this.onCommand(cmd); }
    catch (err) { result = { id: cmd.id, ok: false, error: (err as Error).message ?? String(err), errorCode: (err as { code?: string }).code ?? 'internal_error' }; }
    this.send({ type: 'result', result });
  }
}
