/**
 * ExtensionPage — the one page object over the extension bridge. It keeps OpenCLI's adapter contract (goto, evaluate,
 * fetchJson, wait, click/fillText/typeText/setChecked…) but every interaction method delegates to the act engine:
 * adapters, compiled tools and the agent drive the page through exactly the same locate → wait → hit-test → real-input
 * path. Plus the session/tab-lifecycle and human-visibility commands our extension adds.
 */
import type { ExtensionBridge } from '../host/bridge.js';
import { BrowserCommandError } from '../host/bridge.js';
import { importDist } from '../lib/opencli.js';
import { buildEvaluateExpression } from '@jackwener/opencli/browser/utils';
import type { RuntimePage } from './page-types.js';
import type { Command, ActSpec, ActResult, DialogInfo } from '../protocol.js';
import { pageCallJs, refToTarget, parseKey } from '../shared/engine.js';

export interface ExtensionPageOptions {
  session: string;
  surface: 'browser' | 'adapter';
  siteSession?: 'ephemeral' | 'persistent';
  windowMode?: 'foreground' | 'background';
  idleTimeout?: number;
  contextId?: string;
}

export interface UserTabInfo { tabId: number; title?: string; url?: string; windowId: number; active: boolean; groupId?: number; lastAccessed?: number }

/** Extra methods available on extension-backed pages. */
export interface ExtensionPageExtras {
  nameSession(name: string): Promise<void>;
  userTabs(): Promise<UserTabInfo[]>;
  claim(tab: { tabId?: number; title?: string; url?: string }): Promise<{ page: string; url?: string; title?: string }>;
  mark(page: string, mark: 'deliverable' | 'handoff' | null): Promise<void>;
  finalize(keep: Array<{ page: string; status: 'deliverable' | 'handoff' }>): Promise<{ closed: string[]; kept: string[] }>;
  cursor(x: number, y: number, opts?: { waitForArrival?: boolean }): Promise<void>;
  setVisibility(visible: boolean): Promise<void>;
  getVisibility(): Promise<boolean>;
}

export type ExtensionRuntimePage = RuntimePage & ExtensionPageExtras;

type Lib = {
  CDPBasePage: new () => object;
  generateStealthJs: () => string;
  waitForDomStableJs: (maxMs: number, quietMs: number) => string;
  classifyBrowserError: (err: unknown) => { kind: string; delayMs: number };
  saveBase64ToFile: (b64: string, path: string) => Promise<void>;
};

let libPromise: Promise<Lib> | null = null;
function loadLib(): Promise<Lib> {
  if (!libPromise) {
    libPromise = Promise.all([importDist('browser/base-page.js'), importDist('browser/stealth.js'), importDist('browser/dom-helpers.js'), importDist('browser/errors.js'), importDist('utils.js')])
      .then(([bp, st, dh, er, ut]) => ({ CDPBasePage: bp.CDPBasePage, generateStealthJs: st.generateStealthJs, waitForDomStableJs: dh.waitForDomStableJs, classifyBrowserError: er.classifyBrowserError, saveBase64ToFile: ut.saveBase64ToFile }));
  }
  return libPromise;
}

function isStalePageIdentityError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('stale page identity') || /^Page not found:\s*\S+\s*$/.test(message);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PageClass: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function definePageClass(lib: Lib): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Base = lib.CDPBasePage as any;
  return class ExtensionPage extends Base {
    readonly session: string;
    readonly surface: 'browser' | 'adapter';
    private readonly bridge: ExtensionBridge;
    private readonly opts: ExtensionPageOptions;
    private _page: string | undefined;

    constructor(bridge: ExtensionBridge, opts: ExtensionPageOptions) {
      super();
      this.bridge = bridge;
      this.opts = opts;
      this.session = opts.session;
      this.surface = opts.surface;
    }

    private sessionOpts(): Partial<Command> {
      const o = this.opts;
      return { session: o.session, surface: o.surface, ...(o.contextId && { contextId: o.contextId }), ...(o.idleTimeout != null && { idleTimeout: o.idleTimeout }), ...(o.windowMode && { windowMode: o.windowMode }), ...(o.siteSession && { siteSession: o.siteSession }) };
    }
    private cmdOpts(): Partial<Command> { return { ...this.sessionOpts(), ...(this._page !== undefined && { page: this._page }) }; }

    private async send(action: Command['action'], params: Partial<Command> = {}): Promise<{ data: unknown; page?: string }> {
      try {
        return await this.bridge.send(action, { ...this.cmdOpts(), ...params });
      } catch (err) {
        if (isStalePageIdentityError(err) && this._page !== undefined && action === 'navigate') {
          this._page = undefined;
          return this.bridge.send(action, { ...this.cmdOpts(), ...params });
        }
        throw err;
      }
    }

    async goto(url: string, options?: { waitUntil?: 'load' | 'none'; settleMs?: number }): Promise<void> {
      const result = await this.send('navigate', { url });
      if (result.page) this._page = result.page;
      this._lastUrl = url;
      if (options?.waitUntil !== 'none') {
        const maxMs = options?.settleMs ?? 1000;
        const code = `${lib.generateStealthJs()};\n${lib.waitForDomStableJs(maxMs, Math.min(500, maxMs))}`;
        try { await this.send('exec', { code }); } catch (err) {
          const advice = lib.classifyBrowserError(err);
          if (advice.kind !== 'target-navigation') throw err;
          await new Promise((r) => setTimeout(r, advice.delayMs));
          try { await this.send('exec', { code }); } catch (retryErr) { if (lib.classifyBrowserError(retryErr).kind !== 'target-navigation') throw retryErr; }
        }
      } else {
        try { await this.send('exec', { code: lib.generateStealthJs() }); } catch { /* ignore */ }
      }
    }
    getActivePage(): string | undefined { return this._page; }
    setActivePage(page?: string): void { this._page = page; this._lastUrl = null; }

    async evaluate(input: unknown, ...args: unknown[]): Promise<unknown> {
      const code = buildEvaluateExpression(input as string, args);
      try { return (await this.send('exec', { code })).data; } catch (err) {
        const advice = lib.classifyBrowserError(err);
        if (advice.kind !== 'target-navigation') throw err;
        await new Promise((r) => setTimeout(r, advice.delayMs));
        return (await this.send('exec', { code })).data;
      }
    }
    async getCookies(opts: { domain?: string; url?: string } = {}): Promise<unknown[]> {
      const r = await this.bridge.send('cookies', { ...this.sessionOpts(), ...opts });
      return Array.isArray(r.data) ? r.data : [];
    }
    async closeWindow(): Promise<void> {
      try { await this.bridge.send('session-finalize', { ...this.sessionOpts(), keep: [] }); } catch { /* ignore */ }
      this._page = undefined; this._lastUrl = null;
    }
    async tabs(): Promise<unknown[]> { const r = await this.bridge.send('tabs', { op: 'list', ...this.sessionOpts() }); return Array.isArray(r.data) ? r.data : []; }
    async newTab(url?: string): Promise<string | undefined> {
      const r = await this.bridge.send('tabs', { op: 'new', ...(url !== undefined && { url }), ...this.sessionOpts() });
      this._lastUrl = null;
      return r.page;
    }
    async closeTab(target?: number | string): Promise<void> {
      const params: Partial<Command> = { op: 'close', ...this.sessionOpts() };
      if (typeof target === 'number') params.index = target; else if (typeof target === 'string') params.page = target; else if (this._page !== undefined) params.page = this._page;
      const r = await this.bridge.send('tabs', params);
      const closed = (r.data as { closed?: string } | undefined)?.closed;
      if ((closed && closed === this._page) || (!closed && (target === undefined || target === this._page))) { this._page = undefined; this._lastUrl = null; }
    }
    async selectTab(target: number | string): Promise<void> {
      const r = await this.bridge.send('tabs', { op: 'select', ...(typeof target === 'number' ? { index: target } : { page: target }), ...this.sessionOpts() });
      if (r.page) this._page = r.page;
      this._lastUrl = null;
    }
    async screenshot(options: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; width?: number; height?: number; path?: string } = {}): Promise<string> {
      const r = await this.send('screenshot', { format: options.format, quality: options.quality, fullPage: options.fullPage, width: options.width, height: options.height });
      const b64 = r.data as string;
      if (options.path) await lib.saveBase64ToFile(b64, options.path);
      return b64;
    }
    async startNetworkCapture(pattern = ''): Promise<boolean> { await this.send('network-capture-start', { pattern }); return true; }
    async readNetworkCapture(): Promise<unknown[]> { const r = await this.send('network-capture-read'); return Array.isArray(r.data) ? r.data : []; }
    async waitForDownload(pattern = '', timeoutMs = 30_000): Promise<unknown> { return (await this.send('wait-download', { pattern, timeoutMs })).data; }
    async setFileInput(files: string[], selector?: string): Promise<void> { await this.send('set-file-input', { files, selector }); }
    async insertText(text: string): Promise<void> { await this.send('insert-text', { text }); }
    async frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string }>> { const r = await this.send('frames'); return Array.isArray(r.data) ? r.data as Array<{ index: number; frameId: string; url: string; name: string }> : []; }
    async evaluateInFrame(js: string, frameIndex: number): Promise<unknown> { return (await this.send('exec', { code: buildEvaluateExpression(js), frameIndex })).data; }
    async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> { return (await this.send('cdp', { cdpMethod: method, cdpParams: params })).data; }

    // ── opencli-mcp extras ──
    async nameSession(name: string): Promise<void> { await this.bridge.send('session-name', { ...this.sessionOpts(), name }); }
    async userTabs(): Promise<UserTabInfo[]> { const r = await this.bridge.send('user-tabs', { ...this.sessionOpts() }); return Array.isArray(r.data) ? r.data as UserTabInfo[] : []; }
    async claim(tab: { tabId?: number; title?: string; url?: string }): Promise<{ page: string; url?: string; title?: string }> {
      const r = await this.bridge.send('claim', { ...this.sessionOpts(), claim: tab });
      if (r.page) this._page = r.page;
      const d = (r.data ?? {}) as { url?: string; title?: string };
      return { page: r.page ?? '', url: d.url, title: d.title };
    }
    async mark(page: string, mark: 'deliverable' | 'handoff' | null): Promise<void> { await this.bridge.send('mark', { ...this.sessionOpts(), page, mark }); }
    async finalize(keep: Array<{ page: string; status: 'deliverable' | 'handoff' }>): Promise<{ closed: string[]; kept: string[] }> {
      const r = await this.bridge.send('session-finalize', { ...this.sessionOpts(), keep });
      this._page = undefined;
      return (r.data ?? { closed: [], kept: [] }) as { closed: string[]; kept: string[] };
    }
    async cursor(x: number, y: number, opts: { waitForArrival?: boolean } = {}): Promise<void> {
      try { await this.send('cursor', { x, y, waitForArrival: opts.waitForArrival ?? true, timeoutMs: 1500 }); } catch (err) {
        if (!(err instanceof BrowserCommandError)) throw err; /* overlay is best-effort */
      }
    }
    async pageCall(fn: string, args?: unknown, timeoutMs?: number): Promise<unknown> { return (await this.send('exec', { code: pageCallJs(fn, args), world: 'engine', ...(timeoutMs && { timeoutMs }) })).data; }
    /** Live URL first; OpenCLI's sticky cache (a one-command-per-process habit) is only the fallback while a navigation is in flight. */
    async getCurrentUrl(): Promise<string | null> {
      try { const u = await this.evaluate('location.href') as unknown; if (typeof u === 'string' && u) { this._lastUrl = u; return u; } } catch { /* mid-navigation */ }
      return this._lastUrl ?? null;
    }
    async history(op: 'reload' | 'back' | 'forward'): Promise<{ url?: string; title?: string; timedOut?: boolean }> { const r = (await this.send('history', { historyOp: op, timeoutMs: 20_000 })).data as { url?: string; title?: string; timedOut?: boolean }; this._lastUrl = r.url ?? null; return r; }
    async dialog(op: 'get' | 'accept' | 'dismiss', text?: string): Promise<{ dialog: DialogInfo | null; handled?: string }> { return (await this.send('dialog', { dialogOp: op, ...(text !== undefined && { text }), timeoutMs: 10_000 })).data as { dialog: DialogInfo | null; handled?: string }; }
    async act(spec: ActSpec): Promise<ActResult> {
      const budget = spec.timeoutMs ?? 3000;
      const r = (await this.send('act', { act: { ...spec, timeoutMs: budget }, timeoutMs: budget + 8000 })).data as ActResult;
      // an action may navigate (link click, Enter in a form): the cached URL from goto is no longer trustworthy
      if (r.navigated) this._lastUrl = r.url ?? null; else if (spec.kind === 'click' || spec.kind === 'dblclick' || spec.kind === 'press') this._lastUrl = null;
      return r;
    }
    async setVisibility(visible: boolean): Promise<void> { await this.bridge.send('visibility', { ...this.sessionOpts(), visible }); }

    // ── OpenCLI adapter contract, served by the act engine (no second locator engine) ──
    /** Accessibility snapshot text (the agent's observation) for adapters and compiled tools. */
    async aria(opts: { viewport?: boolean } = {}): Promise<string> { return String(await this.pageCall('aria', { viewport: Boolean(opts.viewport) })); }
    async click(ref: string, opts: { nth?: number; firstOnMulti?: boolean } = {}): Promise<{ ref: string; matches_n: number; match_level: 'exact'; click_method: string; hit: string }> {
      const r = await this.act({ kind: 'click', target: refToTarget(ref, opts) });
      return { ref, matches_n: r.matches_n, match_level: 'exact', click_method: r.method, hit: r.hit };
    }
    async hover(ref: string, opts: { nth?: number; firstOnMulti?: boolean } = {}): Promise<{ matches_n: number; match_level: 'exact' }> { const r = await this.act({ kind: 'hover', target: refToTarget(ref, opts) }); return { matches_n: r.matches_n, match_level: 'exact' }; }
    async focus(ref: string, opts: { nth?: number; firstOnMulti?: boolean } = {}): Promise<{ focused: boolean; matches_n: number; match_level: 'exact' }> { const r = await this.act({ kind: 'focus', target: refToTarget(ref, opts) }); return { focused: true, matches_n: r.matches_n, match_level: 'exact' }; }
    async typeText(ref: string, text: string, opts: { nth?: number; firstOnMulti?: boolean } = {}): Promise<{ matches_n: number; match_level: 'exact' }> { const r = await this.act({ kind: 'type', target: refToTarget(ref, opts), value: text }); return { matches_n: r.matches_n, match_level: 'exact' }; }
    async fillText(ref: string, text: string, opts: { nth?: number; firstOnMulti?: boolean } = {}): Promise<{ filled: boolean; verified: boolean; expected: string; actual: string; length: number; matches_n: number; match_level: 'exact' }> {
      const r = await this.act({ kind: 'fill', target: refToTarget(ref, opts), value: text });
      return { filled: Boolean(r.filled), verified: Boolean(r.verified), expected: text, actual: r.actual ?? '', length: text.length, matches_n: r.matches_n, match_level: 'exact' };
    }
    async setChecked(ref: string, checked: boolean, opts: { nth?: number; firstOnMulti?: boolean } = {}): Promise<{ checked: boolean; changed: boolean; matches_n: number; match_level: 'exact' }> {
      const r = await this.act({ kind: checked ? 'check' : 'uncheck', target: refToTarget(ref, opts) });
      return { checked: Boolean(r.checked), changed: Boolean(r.changed), matches_n: r.matches_n, match_level: 'exact' };
    }
    async uploadFiles(ref: string, files: string[], opts: { nth?: number; firstOnMulti?: boolean } = {}): Promise<{ uploaded: boolean; files: number; file_names: string[]; target: string; matches_n: number; match_level: 'exact' }> {
      const r = await this.act({ kind: 'upload', target: refToTarget(ref, opts), files });
      return { uploaded: true, files: files.length, file_names: files.map((f) => f.split('/').pop() ?? f), target: ref, matches_n: r.matches_n, match_level: 'exact' };
    }
    async drag(source: string, target: string, opts: { from?: { nth?: number; firstOnMulti?: boolean }; to?: { nth?: number; firstOnMulti?: boolean } } = {}): Promise<{ dragged: boolean; source: string; target: string; source_matches_n: number; target_matches_n: number; source_match_level: 'exact'; target_match_level: 'exact' }> {
      const r = await this.act({ kind: 'drag', target: refToTarget(source, opts.from), to: refToTarget(target, opts.to) });
      return { dragged: true, source, target, source_matches_n: r.matches_n, target_matches_n: 1, source_match_level: 'exact', target_match_level: 'exact' };
    }
    async scrollTo(ref: string, opts: { nth?: number; firstOnMulti?: boolean } = {}): Promise<{ matches_n: number }> { const r = await this.act({ kind: 'hover', target: refToTarget(ref, opts) }); return { matches_n: r.matches_n }; }
    async pressKey(key: string): Promise<void> {
      const { def, modifiers } = parseKey(key);
      await this.cdp('Input.dispatchKeyEvent', { type: def.text ? 'keyDown' : 'rawKeyDown', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers, ...(def.text && { text: def.text, unmodifiedText: def.text }) });
      await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers });
    }
    async scroll(direction = 'down', amount = 600): Promise<void> {
      const vp = await this.evaluate('({ x: innerWidth / 2, y: innerHeight / 2 })') as { x: number; y: number };
      await this.act({ kind: 'scroll', target: { x: vp.x, y: vp.y }, direction: direction as 'up' | 'down' | 'left' | 'right', amount });
    }
    async nativeClick(x: number, y: number): Promise<void> { await this.act({ kind: 'click', target: { x, y } }); }
    async nativeType(text: string): Promise<void> { await this.insertText(text); }
    async nativeKeyPress(key: string, modifiers: string[] = []): Promise<void> { await this.pressKey([...modifiers, key].join('+')); }
    async getVisibility(): Promise<boolean> { const r = await this.bridge.send('visibility', { ...this.sessionOpts() }); return Boolean((r.data as { visible?: boolean } | undefined)?.visible); }
  };
}

export async function createExtensionPage(bridge: ExtensionBridge, opts: ExtensionPageOptions): Promise<ExtensionRuntimePage> {
  const lib = await loadLib();
  if (!PageClass) PageClass = definePageClass(lib);
  return new PageClass(bridge, opts) as ExtensionRuntimePage;
}
