/**
 * ExtensionPage — the one page object over the extension bridge, standalone (no OpenCLI CDPBasePage base).
 * Every locator/interaction goes through the act engine (our Playwright injected script in the isolated world);
 * the OpenCLI adapter contract (goto, evaluate, fetchJson, wait, autoScroll, click/fillText/typeText/…) is served
 * here on that one engine. Utility JS (wait/autoScroll/interceptor/network) is reused as pure helper strings — not a
 * second locator/AX engine. Plus the session/tab-lifecycle and human-visibility commands our extension adds.
 */
import type { ExtensionBridge } from '../host/bridge.js';
import { BrowserCommandError } from '../host/bridge.js';
import { importDist } from '../lib/opencli.js';
import { buildEvaluateExpression } from '@jackwener/opencli/browser/utils';
import type { RuntimePage } from './page-types.js';
import type { Command, ActSpec, ActResult, DialogInfo, ConsoleEntry } from '../protocol.js';
import { pageCallJs, refToTarget, parseKey, ActError } from '../shared/engine.js';
import type { Expectation, CheckResult } from '../shared/page-contract.js';

export interface ExtensionPageOptions {
  session: string;
  surface: 'browser' | 'adapter';
  siteSession?: 'ephemeral' | 'persistent';
  windowMode?: 'foreground' | 'background';
  /** bind this page object to one tab identity for its whole life (per-Tab pages); omitted = session-scope page with no tab */
  page?: string;
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

// Pure helper-JS generators + small utilities from OpenCLI's dist — these are plain page-script strings, not a locator/AX engine.
interface Lib {
  waitForDomStableJs: (maxMs: number, quietMs: number) => string;
  waitForSelectorJs: (selector: string, timeoutMs: number) => string;
  waitForTextJs: (text: string, timeoutMs: number) => string;
  autoScrollJs: (times: number, delayMs: number) => string;
  networkRequestsJs: (includeStatic: boolean) => string;
  waitForCaptureJs: (maxMs: number) => string;
  generateInterceptorJs: (pattern: string, opts: { arrayName: string; patchGuard: string }) => string;
  generateReadInterceptedJs: (arrayName: string) => string;
  classifyBrowserError: (err: unknown) => { kind: string; delayMs: number };
  saveBase64ToFile: (b64: string, path: string) => Promise<void>;
}

let libPromise: Promise<Lib> | null = null;
function loadLib(): Promise<Lib> {
  if (!libPromise) {
    libPromise = Promise.all([importDist('browser/dom-helpers.js'), importDist('interceptor.js'), importDist('browser/errors.js'), importDist('utils.js')])
      .then(([dh, ic, er, ut]) => ({
        waitForDomStableJs: dh.waitForDomStableJs, waitForSelectorJs: dh.waitForSelectorJs, waitForTextJs: dh.waitForTextJs,
        autoScrollJs: dh.autoScrollJs, networkRequestsJs: dh.networkRequestsJs, waitForCaptureJs: dh.waitForCaptureJs,
        generateInterceptorJs: ic.generateInterceptorJs, generateReadInterceptedJs: ic.generateReadInterceptedJs,
        classifyBrowserError: er.classifyBrowserError, saveBase64ToFile: ut.saveBase64ToFile,
      }));
  }
  return libPromise;
}

function isStalePageIdentityError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('stale page identity') || /^Page not found:\s*\S+\s*$/.test(message);
}

class ExtensionPage {
  readonly session: string;
  readonly surface: 'browser' | 'adapter';
  private readonly bridge: ExtensionBridge;
  private readonly opts: ExtensionPageOptions;
  private readonly lib: Lib;
  private _page: string | undefined;
  private _lastUrl: string | null = null;
  /** A page created for one tab keeps that identity for life: it never adopts another tab, and once its tab is closed or released every command fails with stale_page. */
  private readonly bound: boolean;
  private closed = false;

  constructor(bridge: ExtensionBridge, opts: ExtensionPageOptions, lib: Lib) {
    this.bridge = bridge;
    this.opts = opts;
    this.lib = lib;
    this.session = opts.session;
    this.surface = opts.surface;
    this._page = opts.page;
    this.bound = opts.page !== undefined;
  }
  private assertOpen(): void {
    if (this.closed) throw new BrowserCommandError(`tab ${this._page} was closed`, 'stale_page', 'The tab this object was bound to no longer exists; open or claim another tab.');
  }

  private sessionOpts(): Partial<Command> {
    const o = this.opts;
    return { session: o.session, surface: o.surface, ...(o.windowMode && { windowMode: o.windowMode }), ...(o.siteSession && { siteSession: o.siteSession }) };
  }
  private cmdOpts(): Partial<Command> { return { ...this.sessionOpts(), ...(this._page !== undefined && { page: this._page }) }; }

  private async send(action: Command['action'], params: Partial<Command> = {}): Promise<{ data: unknown; page?: string }> {
    this.assertOpen();
    try {
      return await this.bridge.send(action, { ...this.cmdOpts(), ...params });
    } catch (err) {
      // an unbound (session-level) page may fall through to a fresh tab; a bound one reports its tab as gone
      if (isStalePageIdentityError(err) && this._page !== undefined && action === 'navigate' && !this.bound) {
        this._page = undefined;
        return this.bridge.send(action, { ...this.cmdOpts(), ...params });
      }
      throw err;
    }
  }

  async goto(url: string, options?: { waitUntil?: 'load' | 'none'; settleMs?: number }): Promise<void> {
    const result = await this.send('navigate', { url });
    if (result.page && !this.bound) this._page = result.page;
    this._lastUrl = url;
    if (options?.waitUntil !== 'none') {
      // We drive the user's real Chrome via the extension — no anti-detection stealth needed; just wait for the DOM to settle.
      const maxMs = options?.settleMs ?? 1000;
      const code = this.lib.waitForDomStableJs(maxMs, Math.min(500, maxMs));
      try { await this.send('exec', { code }); } catch (err) {
        const advice = this.lib.classifyBrowserError(err);
        if (advice.kind !== 'target-navigation') throw err;
        await new Promise((r) => setTimeout(r, advice.delayMs));
        try { await this.send('exec', { code }); } catch (retryErr) { if (this.lib.classifyBrowserError(retryErr).kind !== 'target-navigation') throw retryErr; }
      }
    }
  }
  getActivePage(): string | undefined { return this._page; }

  async evaluate(input: unknown, ...args: unknown[]): Promise<unknown> {
    const code = buildEvaluateExpression(input as string, args);
    try { return (await this.send('exec', { code })).data; } catch (err) {
      const advice = this.lib.classifyBrowserError(err);
      if (advice.kind !== 'target-navigation') throw err;
      await new Promise((r) => setTimeout(r, advice.delayMs));
      return (await this.send('exec', { code })).data;
    }
  }
  /** Evaluate `js` with named args injected as `const` declarations (OpenCLI adapter contract). */
  async evaluateWithArgs(js: string, args: Record<string, unknown>): Promise<unknown> {
    const declarations = Object.entries(args).map(([key, value]) => {
      if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) throw new Error(`evaluateWithArgs: invalid key "${key}"`);
      return `const ${key} = ${JSON.stringify(value)};`;
    }).join('\n');
    // Wrap in an async IIFE (not a bare `{…}` block): the page evaluates this string via CDP Runtime.evaluate as a
    // script, where a top-level `return` (which `js` uses) is illegal. An IIFE makes the return legal and is passed
    // through unchanged by wrapForEval.
    return this.evaluate(`(async () => {\n${declarations}\n${js}\n})()`);
  }
  /** Fetch JSON through the page (its cookies, its origin) — the network-first way to freeze a site. */
  async fetchJson(url: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}): Promise<unknown> {
    const request = { url, method: opts.method ?? 'GET', headers: opts.headers ?? {}, body: opts.body, hasBody: opts.body !== undefined, timeoutMs: opts.timeoutMs ?? 15_000 };
    const result = await this.evaluateWithArgs(`
      return (async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), request.timeoutMs);
        try {
          const headers = { Accept: 'application/json', ...request.headers };
          const init = { method: request.method, credentials: 'include', headers, signal: ctrl.signal };
          if (request.hasBody) {
            if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(request.body);
          }
          const resp = await fetch(request.url, init);
          const text = await resp.text();
          return { ok: resp.ok, status: resp.status, statusText: resp.statusText, url: resp.url, contentType: resp.headers.get('content-type') || '', text };
        } catch (error) {
          return { ok: false, status: 0, statusText: '', url: request.url, contentType: '', text: '', error: error instanceof Error ? error.message : String(error) };
        } finally { clearTimeout(timer); }
      })()
    `, { request }) as { ok: boolean; status: number; statusText: string; url: string; contentType: string; text: string; error?: string };
    const targetUrl = result.url || url;
    if (result.error) throw new ActError('fetch_error', `Browser fetch failed for ${targetUrl}: ${result.error}`, 'Check that the page is reachable and the current browser profile has access.');
    if (!result.ok) throw new ActError('fetch_error', `HTTP ${result.status ?? 0}${result.statusText ? ` ${result.statusText}` : ''} from ${targetUrl}`, result.text.slice(0, 200));
    const text = result.text ?? '';
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch { throw new ActError('fetch_error', `Expected JSON from ${targetUrl}${result.contentType ? ` (${result.contentType})` : ''}`, text.slice(0, 200)); }
  }
  async getCookies(opts: { domain?: string; url?: string } = {}): Promise<unknown[]> {
    const r = await this.bridge.send('cookies', { ...this.sessionOpts(), ...opts });
    return Array.isArray(r.data) ? r.data : [];
  }
  async closeWindow(): Promise<void> {
    try { await this.bridge.send('session-finalize', { ...this.sessionOpts(), keep: [] }); } catch { /* ignore */ }
    if (this.bound) this.closed = true; else this._page = undefined;
    this._lastUrl = null;
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
    if ((closed && closed === this._page) || (!closed && (target === undefined || target === this._page))) { if (this.bound) this.closed = true; else this._page = undefined; this._lastUrl = null; }
  }
  async selectTab(target: number | string): Promise<void> {
    const r = await this.bridge.send('tabs', { op: 'select', ...(typeof target === 'number' ? { index: target } : { page: target }), ...this.sessionOpts() });
    if (r.page) this._page = r.page;
    this._lastUrl = null;
  }
  async screenshot(options: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; width?: number; height?: number; path?: string } = {}): Promise<string> {
    const r = await this.send('screenshot', { format: options.format, quality: options.quality, fullPage: options.fullPage, width: options.width, height: options.height });
    const b64 = r.data as string;
    if (options.path) await this.lib.saveBase64ToFile(b64, options.path);
    return b64;
  }
  /** Screenshot with eN ref labels overlaid, using our own annotate overlay (one engine). */
  async annotatedScreenshot(options: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; width?: number; height?: number; path?: string } = {}): Promise<string> {
    try { await this.pageCall('annotate'); return await this.screenshot(options); }
    finally { await this.pageCall('unannotate').catch(() => {}); }
  }
  async startNetworkCapture(pattern = ''): Promise<boolean> { await this.send('network-capture-start', { pattern }); return true; }
  async readNetworkCapture(): Promise<unknown[]> { const r = await this.send('network-capture-read'); return Array.isArray(r.data) ? r.data : []; }
  /** Page-side performance entries (fallback when CDP capture is unavailable) — a pure helper script, not a locator. */
  async networkRequests(includeStatic = false): Promise<unknown[]> { const r = await this.evaluate(this.lib.networkRequestsJs(includeStatic)); return Array.isArray(r) ? r : []; }
  async waitForDownload(pattern = '', timeoutMs = 30_000): Promise<unknown> { return (await this.send('wait-download', { pattern, timeoutMs })).data; }
  async setFileInput(files: string[], selector?: string): Promise<void> { await this.send('set-file-input', { files, selector }); }
  async insertText(text: string): Promise<void> { await this.send('insert-text', { text }); }
  async frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string }>> { const r = await this.send('frames'); return Array.isArray(r.data) ? r.data as Array<{ index: number; frameId: string; url: string; name: string }> : []; }
  async evaluateInFrame(js: string, frameIndex: number): Promise<unknown> { return (await this.send('exec', { code: buildEvaluateExpression(js), frameIndex })).data; }
  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> { return (await this.send('cdp', { cdpMethod: method, cdpParams: params })).data; }

  // ── OpenCLI adapter utility contract, served on our engine (pure helper JS, no shadow locator) ──
  async sleep(seconds: number): Promise<void> { await new Promise((r) => setTimeout(r, seconds * 1000)); }
  async wait(options: number | { time?: number; selector?: string; text?: string; timeout?: number }): Promise<void> {
    if (typeof options === 'number') {
      if (options >= 1) { try { const maxMs = options * 1000; await this.evaluate(this.lib.waitForDomStableJs(maxMs, Math.min(500, maxMs))); return; } catch { /* fall through to sleep */ } }
      await new Promise((r) => setTimeout(r, options * 1000)); return;
    }
    if (typeof options.time === 'number') { await new Promise((r) => setTimeout(r, options.time! * 1000)); return; }
    if (options.selector) { await this.evaluate(this.lib.waitForSelectorJs(options.selector, (options.timeout ?? 10) * 1000)); return; }
    if (options.text) { await this.evaluate(this.lib.waitForTextJs(options.text, (options.timeout ?? 30) * 1000)); }
  }
  async autoScroll(options?: { times?: number; delayMs?: number }): Promise<void> { await this.evaluate(this.lib.autoScrollJs(options?.times ?? 3, options?.delayMs ?? 2000)); }
  /** Accessibility snapshot for adapters — our aria snapshot (one AX/ref space, no shadow _axRefs). */
  async snapshot(_opts: Record<string, unknown> = {}): Promise<string> { return this.aria({ viewport: false }); }
  async installInterceptor(pattern: unknown): Promise<void> { await this.evaluate(this.lib.generateInterceptorJs(JSON.stringify(pattern), { arrayName: '__opencli_xhr', patchGuard: '__opencli_interceptor_patched' })); }
  async getInterceptedRequests(): Promise<unknown[]> { const r = await this.evaluate(this.lib.generateReadInterceptedJs('__opencli_xhr')); return Array.isArray(r) ? r : []; }
  async waitForCapture(timeout = 10): Promise<void> { await this.evaluate(this.lib.waitForCaptureJs(timeout * 1000)); }

  // ── opencli-mcp extras ──
  async nameSession(name: string): Promise<void> { await this.bridge.send('session-name', { ...this.sessionOpts(), name }); }
  async userTabs(): Promise<UserTabInfo[]> { const r = await this.bridge.send('user-tabs', { ...this.sessionOpts() }); return Array.isArray(r.data) ? r.data as UserTabInfo[] : []; }
  async claim(tab: { tabId?: number; title?: string; url?: string }): Promise<{ page: string; url?: string; title?: string }> {
    const r = await this.bridge.send('claim', { ...this.sessionOpts(), claim: tab });
    if (r.page && !this.bound) this._page = r.page;
    const d = (r.data ?? {}) as { url?: string; title?: string };
    return { page: r.page ?? '', url: d.url, title: d.title };
  }
  async mark(page: string, mark: 'deliverable' | 'handoff' | null): Promise<void> { await this.bridge.send('mark', { ...this.sessionOpts(), page, mark }); }
  async finalize(keep: Array<{ page: string; status: 'deliverable' | 'handoff' }>): Promise<{ closed: string[]; kept: string[] }> {
    const r = await this.bridge.send('session-finalize', { ...this.sessionOpts(), keep });
    if (this.bound) this.closed = true; else this._page = undefined;
    return (r.data ?? { closed: [], kept: [] }) as { closed: string[]; kept: string[] };
  }
  async cursor(x: number, y: number, opts: { waitForArrival?: boolean } = {}): Promise<void> {
    try { await this.send('cursor', { x, y, waitForArrival: opts.waitForArrival ?? true, timeoutMs: 1500 }); } catch (err) {
      if (!(err instanceof BrowserCommandError)) throw err; /* overlay is best-effort */
    }
  }
  async pageCall(fn: string, args?: unknown, timeoutMs?: number): Promise<unknown> { return (await this.send('exec', { code: pageCallJs(fn, args), world: 'engine', ...(timeoutMs && { timeoutMs }) })).data; }
  /** Live URL first; the sticky cache is only the fallback while a navigation is in flight. */
  async getCurrentUrl(): Promise<string | null> {
    try { const u = await this.evaluate('location.href') as unknown; if (typeof u === 'string' && u) { this._lastUrl = u; return u; } } catch { /* mid-navigation */ }
    return this._lastUrl ?? null;
  }
  async consoleLogs(opts: { afterSequence?: number; limit?: number; levels?: string[]; filter?: string } = {}): Promise<{ cursor: number; entries: ConsoleEntry[]; hasMore: boolean }> { return (await this.send('console', { afterSequence: opts.afterSequence, limit: opts.limit, levels: opts.levels, filter: opts.filter })).data as { cursor: number; entries: ConsoleEntry[]; hasMore: boolean }; }
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

  // ── OpenCLI adapter interaction contract, served by the act engine (no second locator engine) ──
  /** Accessibility snapshot text (the agent's observation) for adapters and compiled tools. */
  async aria(opts: { viewport?: boolean } = {}): Promise<string> { return String(await this.pageCall('aria', { viewport: Boolean(opts.viewport) })); }
  async expect(what: Expectation, opts: { timeoutMs?: number } = {}): Promise<CheckResult> {
    const deadline = Date.now() + (opts.timeoutMs ?? 5000);
    let last: CheckResult | null = null;
    for (;;) {
      try { last = await this.pageCall('check', what, 3000) as CheckResult; if (last.ok) return last; } catch { /* navigation in flight: retry */ }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const state = await this.aria({ viewport: true }).catch(() => '');
    throw new ActError('expectation_failed', last ? last.failed.join('; ') : 'page not reachable', 'Observe the page; the flow may need a different step or a wait.', { expect: what as Record<string, unknown>, failed: last?.failed ?? [], url: last?.url, title: last?.title, state: state.slice(0, 4000) });
  }
  async click(ref: string, opts: { nth?: number; firstOnMulti?: boolean } = {}): Promise<{ ref: string; matches_n: number; match_level: 'exact'; click_method: string; hit: string }> {
    const r = await this.act({ kind: 'click', target: refToTarget(ref, opts) });
    return { ref, matches_n: r.matches_n, match_level: 'exact', click_method: r.method, hit: r.hit };
  }
  async dblClick(ref: string, opts: { nth?: number; firstOnMulti?: boolean } = {}): Promise<{ matches_n: number; match_level: 'exact' }> { const r = await this.act({ kind: 'dblclick', target: refToTarget(ref, opts) }); return { matches_n: r.matches_n, match_level: 'exact' }; }
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
}

export async function createExtensionPage(bridge: ExtensionBridge, opts: ExtensionPageOptions): Promise<ExtensionRuntimePage> {
  const lib = await loadLib();
  return new ExtensionPage(bridge, opts, lib) as unknown as ExtensionRuntimePage;
}
