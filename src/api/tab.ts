/**
 * Tab — one browser tab of a session: observe (aria snapshot + semantic diff), find, act, expect, evaluate, screenshot,
 * network/console/dialog/webmcp/frames. A Tab owns the page object bound to its identity; operations are serialized per tab.
 */
import type { RuntimePage } from '../backends/page-types.js';
import { ActionError } from './errors.js';
import { ariaDiff } from './diff.js';
import { ARIA_BUDGET, collapseAria } from '../shared/aria-collapse.js';
import { targetToSelector, fallbackSelector } from '../shared/engine.js';
import type { FindEntry, FindResult, ElementAtResult, Expectation, CheckResult, ReadTextResult } from '../shared/page-contract.js';
import type { DialogInfo, FrameStep } from '../protocol.js';
import type { SessionContext } from './context.js';

export type Target = ({ frame?: FrameStep | FrameStep[]; /** container (css/selector/eN) to resolve inside */ within?: string }) & (
  | { ref: number | string }
  | { selector: string; nth?: number }
  | { role?: string; name?: string; label?: string; text?: string; testid?: string; nth?: number }
  | { x: number; y: number });

export type ActAction = 'click' | 'dblclick' | 'hover' | 'focus' | 'fill' | 'type' | 'press' | 'select' | 'check' | 'uncheck' | 'upload' | 'drag' | 'scroll' | 'back' | 'forward' | 'reload';

export interface ActOptions { target?: Target; action: ActAction; value?: string; files?: string[]; to?: Target; direction?: 'up' | 'down' | 'left' | 'right'; amount?: number; timeoutMs?: number; settleMs?: number; /** click only. `dom` runs HTMLElement.click() and sends no mouse event. Default is a real mouse event. */ method?: 'cdp' | 'dom' }

export interface ObserveOptions { mode?: 'state' | 'screenshot' | 'both'; /** diff against the previous observe. Off unless explicitly true — a diff is useless when the caller no longer has the base snapshot. */ diff?: boolean; /** only the subtree on screen right now (what a screenshot shows). Not a page of the full tree. */ viewport?: boolean; /** open one branch of the action map (`eN` from a collapsed line). Ignores viewport. */ ref?: string; /** overlay eN labels on the screenshot */ annotate?: boolean; fullPage?: boolean }

export interface ReadOptions { /** stop after this many characters. Default 60000. */ maxChars?: number; /** character offset from the beginning of the document scan */ start?: number }

export interface ImageValue { __image: true; mimeType: string; base64: string }



const WRITE_EVAL_RE = /(\.click\s*\(|\.submit\s*\(|\blocation\s*(=|\.href\s*=|\.assign\s*\(|\.replace\s*\()|document\.write|\.remove\s*\(\)|localStorage\.(setItem|removeItem|clear)|\.value\s*=[^=])/;

export class Tab {
  /** A Tab owns the page object bound to its identity; `bound` lets an adapter pass an existing page. */
  constructor(readonly id: string, private readonly ctx: SessionContext, private readonly bound?: RuntimePage) {}
  private closed = false;

  /** Run `fn` on this tab's own page object. Operations are serialized per tab, never across tabs. */
  async use<T>(fn: (page: RuntimePage) => Promise<T>): Promise<T> {
    const state = this.ctx.state;
    const prev = state.tabLocks.get(this.id) ?? Promise.resolve();
    let release!: () => void;
    state.tabLocks.set(this.id, new Promise<void>((r) => { release = r; }));
    try {
      await prev;
      if (this.closed) throw new ActionError('stale_page', `tab ${this.id} was closed`, 'This Tab object is dead; open or claim another tab.');
      if (state.finalized && !state.pages.has(this.id)) throw new ActionError('page_released', `tab ${this.id} was released by finalize`, 'finalize ends the session\'s control of its tabs; open a new tab or claim the tab again (browser.user.claimTab).');
      state.selected = this.id;
      const page = this.bound ?? await this.ctx.rt.pageFor(this.ctx.sessionId, this.id);
      return await fn(page);
    } finally { release(); }
  }

  async goto(url: string, opts: { waitUntil?: 'load' | 'none'; settleMs?: number } = {}): Promise<{ url: string | null; title: string | null }> {
    if (!/^(https?:\/\/|data:text\/html)/i.test(url)) throw new ActionError('invalid_url', 'Only http(s) (or data:text/html) URLs can be opened', 'Pass an absolute http:// or https:// URL');
    return this.use(async (page) => {
      await page.goto(url, opts);
      await this.harvest(page);
      return this.info(page);
    });
  }

  /**
   * Pull captured requests into the session's bounded network log. Best effort — never fails a step.
   */
  private async harvest(page: RuntimePage): Promise<Array<Record<string, unknown> & { seq: number }>> {
    // best effort: harvesting must never fail the step that just succeeded
    try { const captured = await page.readNetworkCapture().catch(() => [] as unknown[]) as Array<Record<string, unknown>>; return this.logNetwork(captured); } catch { return []; }
  }
  private logNetwork(entries: Array<Record<string, unknown>>): Array<Record<string, unknown> & { seq: number }> {
    let log = this.ctx.state.netLog.get(this.id);
    if (!log) { log = { seq: 0, entries: [], seen: new Set() }; this.ctx.state.netLog.set(this.id, log); }
    const fresh: Array<Record<string, unknown> & { seq: number }> = [];
    for (const e of entries) {
      const key = String(e.requestId ?? `${e.method ?? 'GET'} ${e.url ?? e.name ?? ''} ${e.timestamp ?? e.startTime ?? e.ts ?? ''}`);
      if (log.seen.has(key)) continue;
      log.seen.add(key);
      const entry = { ...e, seq: ++log.seq }; log.entries.push(entry); fresh.push(entry);
    }
    if (log.entries.length > 2000) log.entries.splice(0, log.entries.length - 2000);
    if (log.seen.size > 8000) log.seen.clear(); // bounded: the extension drains captured entries, so re-dup is rare
    return fresh;
  }
  private async info(page: RuntimePage): Promise<{ url: string | null; title: string | null }> {
    const url = await page.getCurrentUrl().catch(() => null);
    const title = await page.evaluate<string>('document.title').catch(() => null);
    return { url, title };
  }
  async url(): Promise<string | null> { return this.use((p) => p.getCurrentUrl()); }
  async title(): Promise<string | null> { return this.use((p) => p.evaluate<string>('document.title')); }
  async back(): Promise<void> { await this.use((p) => p.history('back')); }
  async forward(): Promise<void> { await this.use((p) => p.history('forward')); }
  async reload(): Promise<void> { await this.use((p) => p.history('reload')); }
  /** Close this tab, whether it was opened or claimed by this session. */
  async close(): Promise<void> { await this.use((p) => p.closeTab(this.id)); this.closed = true; this.ctx.rt.forgetPage(this.ctx.sessionId, this.id); }
  /** Keep this tab open and give up this session's control of it. */
  async release(): Promise<void> { await this.use((p) => p.releaseTab(this.id)); this.closed = true; this.ctx.rt.forgetPage(this.ctx.sessionId, this.id); }

  async observe(opts: ObserveOptions = {}): Promise<{ url: string | null; title: string | null; state?: string; diff?: boolean; changed?: { added: number; removed: number; changed?: number }; image?: ImageValue }> {
    const mode = opts.mode ?? 'state';
    return this.use(async (page) => {
      const meta = await this.info(page);
      const out: { url: string | null; title: string | null; state?: string; diff?: boolean; changed?: { added: number; removed: number; changed?: number }; image?: ImageValue } = { ...meta };
      if (mode === 'state' || mode === 'both') {
        // one state source: Playwright's aria snapshot (credential values redacted); its [ref=eN] are the act targets
        let text = String(await page.pageCall('aria', { viewport: Boolean(opts.viewport) && !opts.ref, ...(opts.ref ? { ref: opts.ref } : {}) }));
        const key = `${this.id}:${opts.viewport && !opts.ref ? 'vp' : 'all'}:${opts.ref ?? ''}`;
        const prev = this.ctx.state.lastObserve.get(key);
        this.ctx.state.lastObserve.set(key, text);
        const diffOn = opts.diff === true;
        // the tail line ("Focused: …") is state, not structure: diff the tree, then re-append the current focus
        const split = (t: string) => { const i = t.lastIndexOf('\nFocused: '); return i >= 0 ? [t.slice(0, i), t.slice(i + 1)] : [t, '']; };
        const [tree, focus] = split(text); const [prevTree] = prev ? split(prev) : [''];
        if (diffOn && prev && prevTree !== tree) {
          const d = ariaDiff(prevTree, tree);
          if (d.changedRatio < 0.6) { out.diff = true; out.changed = { added: d.added, removed: d.removed, changed: d.changed }; text = `${d.text || '(no visible change)'}${focus ? `\n${focus}` : ''}`; }
        } else if (diffOn && prev && prevTree === tree) { out.diff = true; out.changed = { added: 0, removed: 0, changed: 0 }; text = `There has been no change since the last observe.${focus ? `\n${focus}` : ''}`; }
        // Diff compared the whole tree. Collapse only the copy the model sees, so a change inside a folded branch is not "no change".
        const unchanged = out.diff === true && out.changed?.added === 0 && out.changed?.removed === 0 && (out.changed?.changed ?? 0) === 0;
        out.state = unchanged ? text : collapseAria(text, ARIA_BUDGET).text;
      }
      if (mode === 'screenshot' || mode === 'both') out.image = await this.screenshotOn(page, { annotate: opts.annotate, fullPage: opts.fullPage });
      return out;
    });
  }

  async screenshot(opts: { fullPage?: boolean; annotate?: boolean; format?: 'png' | 'jpeg'; quality?: number } = {}): Promise<ImageValue> {
    return this.use((page) => this.screenshotOn(page, opts));
  }
  private async screenshotOn(page: RuntimePage, opts: { fullPage?: boolean; annotate?: boolean; format?: 'png' | 'jpeg'; quality?: number }): Promise<ImageValue> {
    // annotate = eN labels of the last aria snapshot drawn by the page module for the capture only
    if (opts.annotate) await page.pageCall('annotate');
    try {
      const b64 = await page.screenshot({ fullPage: opts.fullPage, format: opts.format, quality: opts.quality });
      return { __image: true, mimeType: opts.format === 'jpeg' ? 'image/jpeg' : 'image/png', base64: b64 };
    } finally { if (opts.annotate) await page.pageCall('unannotate').catch(() => {}); }
  }

  async find(target: Target & { limit?: number }): Promise<FindResult | ElementAtResult> {
    return this.use(async (page) => {
      // a viewport point (screenshot coordinates) → the element there and its ancestors, as locators
      if ('x' in target) return await page.pageCall('elementAt', { x: target.x, y: target.y }) as ElementAtResult;
      // same engine and the same compiled selector as act: what find lists is exactly what act would resolve
      const spec = target as Record<string, unknown>;
      const selector = targetToSelector(spec);
      if (!selector) throw new ActionError('invalid_target', 'find needs a selector, an aria ref (eN), a semantic locator (role/name/label/text/testid), or a point {x,y}', 'Pass one of: {ref} from observe, {selector}, {role,name}, {label}, {text}, {testid}, or {x,y}.');
      return await page.pageCall('find', { selector, fallback: fallbackSelector(spec), limit: target.limit ?? 20 }) as FindResult;
    });
  }

  /**
   * Linear text of a bounded document. Scrolls to mount lazy content, dedupes, restores the scroll position.
   * No refs. A feed that grows without a bottom returns reason `unbounded` and the head already read — do not call it again to finish the feed.
   */
  async read(opts: ReadOptions = {}): Promise<ReadTextResult> {
    return this.use(async (page) => {
      const r = await page.pageCall('readText', opts) as ReadTextResult;
      return r;
    });
  }

  /** wait + act in one call at the runtime edge: locate → wait actionable → hit-test → real input → settle. `method:'dom'` skips the mouse event. */
  async act(opts: ActOptions): Promise<Record<string, unknown>> {
    const { action } = opts;
    return this.use(async (page) => {
      try {
        // use the page already held by this.use(): calling this.reload()/back()/forward() here would re-enter the session lock and deadlock
        if (action === 'back' || action === 'forward' || action === 'reload') { const h = await page.history(action); return { action, ...h }; }
        if (action === 'scroll' && !opts.target) {
          // no target: wheel at the viewport centre
          const vp = await page.evaluate<{ x: number; y: number }>('({ x: innerWidth / 2, y: innerHeight / 2 })');
          opts = { ...opts, target: { x: vp.x, y: vp.y } };
        }
        if (!opts.target) throw new ActionError('missing_target', `action "${action}" needs a target`, 'Pass a target: a {ref} from observe, or a selector/role+name/label/text/testid.');
        const r = await page.act({ kind: action, target: opts.target as Record<string, unknown>, value: opts.value, files: opts.files, to: opts.to as Record<string, unknown> | undefined, direction: opts.direction, amount: opts.amount, timeoutMs: opts.timeoutMs, settleMs: opts.settleMs ?? 600, cursor: this.ctx.rt.cursorEnabled, ...(opts.method ? { method: opts.method } : {}) });
        await this.harvest(page);
        // Return the outcome and the fields needed to choose the next action.
        return {
          action,
          ...(r.matches_n > 1 ? { matches_n: r.matches_n } : {}),
          ...(r.navigated ? { navigated: true, ...(r.url !== undefined && { url: r.url }) } : {}),
          ...(r.ref ? { ref: r.ref } : {}),
          ...(r.filled !== undefined ? { filled: r.filled, verified: r.verified, actual: r.actual } : {}),
          ...(r.checked !== undefined ? { checked: r.checked, changed: r.changed } : {}),
          ...(r.selected !== undefined ? { selected: r.selected } : {}),
          ...(r.files !== undefined ? { files: r.files } : {}),
          ...(action === 'click' && r.method === 'dom' ? { method: 'dom' as const } : {}),
        };
      } catch (err) {
        if (err instanceof ActionError) throw err;
        const e = err as { code?: string; message?: string; hint?: string; data?: unknown };
        throw new ActionError(e.code ?? 'action_failed', e.message ?? String(err), e.hint, e.data && typeof e.data === 'object' ? e.data as Record<string, unknown> : undefined);
      }
    });
  }

  /** WebMCP: tools the page itself registers via navigator.modelContext (page-provided tool source). */
  readonly webmcp = {
    list: async (): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> => this.use(async (p) => {
      const r = await p.evaluate(`(async () => { const mc = navigator.modelContext || document.modelContext; if (!mc || typeof mc.getTools !== 'function') return []; const tools = await mc.getTools(); return (tools || []).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })); })()`);
      return Array.isArray(r) ? r as Array<{ name: string; description?: string; inputSchema?: unknown }> : [];
    }),
    call: async (name: string, input: Record<string, unknown> = {}): Promise<unknown> => this.use(async (p) => {
      return p.evaluateWithArgs(`(async () => { const mc = navigator.modelContext || document.modelContext; if (!mc) throw new Error('page exposes no modelContext'); if (typeof mc.executeTool === 'function') return await mc.executeTool(name, input); const tools = await mc.getTools(); const t = (tools || []).find(x => x.name === name); if (!t || typeof t.execute !== 'function') throw new Error('unknown page tool ' + name); return await t.execute(input); })()`, { name, input });
    }),
  };

  /** Assert what the page must show now (polled up to timeoutMs). */
  async expect(what: Expectation, opts: { timeoutMs?: number } = {}): Promise<CheckResult> {
    return this.use(async (page) => {
      try { return await page.expect(what, opts); }
      catch (err) { const e = err as { code?: string; message?: string; hint?: string; extra?: Record<string, unknown> }; throw new ActionError(e.code ?? 'expectation_failed', e.message ?? String(err), e.hint, e.extra); }
    });
  }

  /** Read-only page evaluation. */
  async evaluate(js: string, opts: { allowWrite?: boolean; frame?: number } = {}): Promise<unknown> {
    if (!opts.allowWrite && WRITE_EVAL_RE.test(js)) throw new ActionError('evaluate_read_only', 'evaluate is read-only; use act() for clicks, typing, navigation and form changes', 'Pass allowWrite:true only when the user explicitly wants a scripted page change.');
    return this.use(async (page) => {
      return opts.frame !== undefined ? page.evaluateInFrame(js, opts.frame) : page.evaluate(js);
    });
  }

  /** Native alert/confirm/prompt dialogs block the page; commands fail with `dialog_open` until answered. */
  readonly dialog = {
    get: async (): Promise<DialogInfo | null> => this.use(async (p) => (await p.dialog('get')).dialog),
    accept: async (text?: string): Promise<DialogInfo | null> => this.use(async (p) => (await p.dialog('accept', text)).dialog),
    dismiss: async (): Promise<DialogInfo | null> => this.use(async (p) => (await p.dialog('dismiss')).dialog),
  };

  /** Console messages and uncaught exceptions since the tab was attached (the plugin's tab.dev.logs); cursor-paged like network.read. */
  readonly console = {
    read: async (opts: { afterSequence?: number; limit?: number; levels?: Array<'debug' | 'info' | 'log' | 'warn' | 'error'>; filter?: string } = {}) => this.use((p) => p.consoleLogs(opts)),
  };

  readonly network = {
    start: async (pattern = ''): Promise<boolean> => this.use((p) => p.startNetworkCapture(pattern)),
    /**
     * Cursor-paged read: pass `afterSequence` from the previous result to get only new requests. Returns network rows
     * only; endpoint candidates come from the explicit `recon.discover(tab)` (not a hidden side effect of reading).
     */
    read: async (opts: { pattern?: string; limit?: number; includeStatic?: boolean; afterSequence?: number } = {}): Promise<{ cursor: number; entries: unknown[]; hasMore: boolean }> => this.use(async (p) => {
      await this.harvest(p);
      let log = this.ctx.state.netLog.get(this.id);
      // no capture (adapter tab, or a tab attached before this host): the page's performance entries are all there is
      if (!log || !log.entries.length) { this.logNetwork(await p.networkRequests(opts.includeStatic ?? false).catch(() => []) as Array<Record<string, unknown>>); log = this.ctx.state.netLog.get(this.id)!; }
      const after = opts.afterSequence ?? 0;
      const matching = log.entries.filter((e) => e.seq > after && (!opts.pattern || String(e.url ?? e.name ?? '').includes(opts.pattern)));
      const limit = opts.limit ?? 100;
      const page = matching.slice(0, limit);
      return { cursor: page.length ? page[page.length - 1].seq : after, entries: page, hasMore: matching.length > limit };
    }),
  };
  async cookies(domain: string): Promise<unknown[]> { return this.use((p) => p.getCookies({ domain })); }
  /**
   * Read one cookie's value at run time — useful for per-request tokens an adapter needs (csrf/ct0/
   * csrftoken/XSRF-TOKEN). Defaults to the current page's host. Returns undefined when the cookie is absent.
   */
  async cookie(name: string, opts: { domain?: string } = {}): Promise<string | undefined> {
    let domain = opts.domain;
    if (!domain) { const u = await this.url().catch(() => null); try { domain = u ? new URL(u).hostname : undefined; } catch { domain = undefined; } }
    const list = await this.use((p) => p.getCookies(domain ? { domain } : {})) as Array<{ name?: string; value?: string }>;
    return list.find((c) => c?.name === name)?.value;
  }
  /** Fetch JSON through the page (its cookies and origin) after verifying the endpoint. */
  async fetchJson(url: string, opts: Record<string, unknown> = {}): Promise<unknown> { return this.use((p) => p.fetchJson(url, opts as never)); }
  async frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string; crossOrigin?: boolean; oopif?: boolean }>> { return this.use((p) => p.frames()); }
  async download(pattern = '', timeoutMs = 30_000): Promise<unknown> { return this.use((p) => p.waitForDownload(pattern, timeoutMs)); }
}
