/**
 * Tab — one browser tab of a session: observe (aria snapshot + semantic diff), find, act, expect, evaluate, screenshot,
 * network/console/dialog/webmcp/frames. A Tab owns the page object bound to its identity; operations are serialized per tab.
 */
import type { RuntimePage } from '../backends/page-types.js';
import { ActionError } from './errors.js';
import { Policy } from '../runtime/policy.js';
import { ariaDiff } from './diff.js';
import { targetToSelector, fallbackSelector } from '../shared/engine.js';
import type { FindEntry, FindResult, ElementAtResult, Expectation, CheckResult } from '../shared/page-contract.js';
import type { DialogInfo, FrameStep } from '../protocol.js';
import type { SessionContext } from './context.js';
import type { TraceInput, NetworkEvidence } from '../runtime/trace.js';

export type Target = ({ frame?: FrameStep | FrameStep[]; /** container (css/selector/eN) to resolve inside */ within?: string }) & (
  | { ref: number | string }
  | { selector: string; nth?: number }
  | { role?: string; name?: string; label?: string; text?: string; testid?: string; nth?: number }
  | { x: number; y: number });

export type ActAction = 'click' | 'dblclick' | 'hover' | 'focus' | 'fill' | 'type' | 'press' | 'select' | 'check' | 'uncheck' | 'upload' | 'drag' | 'scroll' | 'back' | 'forward' | 'reload';

export interface ActOptions { target?: Target; action: ActAction; value?: string; files?: string[]; to?: Target; direction?: 'up' | 'down' | 'left' | 'right'; amount?: number; timeoutMs?: number; settleMs?: number }

export interface ObserveOptions { mode?: 'state' | 'screenshot' | 'both'; /** diff against the previous observe. Off unless explicitly true — a diff is useless when the caller no longer has the base snapshot. */ diff?: boolean; /** only the subtree on screen right now (what a screenshot shows) */ viewport?: boolean; /** overlay eN labels on the screenshot */ annotate?: boolean; fullPage?: boolean }

export interface ImageValue { __image: true; mimeType: string; base64: string }



export function describeTarget(t: Target | undefined): string {
  if (!t) return '';
  if ('ref' in t) return `ref:${t.ref}`;
  if ('selector' in t) return `selector:${t.selector}${t.nth !== undefined ? `[${t.nth}]` : ''}`;
  if ('x' in t) return `point:${t.x},${t.y}`;
  return Object.entries(t).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(' ');
}


/** Request headers that are the browser's or the session's, never part of an endpoint's contract. */
const DROP_HEADER = /^(cookie|authorization|user-agent|referer|origin|host|accept-encoding|accept-language|connection|content-length|pragma|cache-control|priority|te|upgrade-insecure-requests|sec-.*|:.*)$/i;
const JSONISH = /json|graphql|x-component|text\/plain|javascript/i;
/** A captured request as the trace records it: enough to freeze the call, nothing that is a credential. */
function networkEvent(e: Record<string, unknown>, page: string, after?: string): NetworkEvidence {
  const rh = (e.requestHeaders ?? {}) as Record<string, string>;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rh)) if (!DROP_HEADER.test(k)) headers[k.toLowerCase()] = v;
  const contentType = String(e.responseContentType ?? e.contentType ?? e.mimeType ?? '') || undefined;
  const preview = typeof e.responsePreview === 'string' ? e.responsePreview : undefined;
  const post = typeof e.requestBodyPreview === 'string' && e.requestBodyPreview ? e.requestBodyPreview.slice(0, 4096) : undefined;
  return {
    page, after, url: String(e.url ?? e.name ?? ''), method: (e.method as string | undefined)?.toUpperCase(),
    status: (e.responseStatus ?? e.status) as number | undefined, contentType,
    bodyBytes: (e.responseBodyFullSize as number | undefined) ?? preview?.length, resourceType: e.resourceType as string | undefined,
    ...(Object.keys(headers).length && { requestHeaders: headers }), ...('authorization' in Object.fromEntries(Object.keys(rh).map((k) => [k.toLowerCase(), 1])) && { auth: true }),
    ...(post && { postData: post }), ...(preview && contentType && JSONISH.test(contentType) && !preview.startsWith('base64:') && { responseSample: preview.slice(0, 8192) }),
  };
}

const WRITE_EVAL_RE = /(\.click\s*\(|\.submit\s*\(|\blocation\s*(=|\.href\s*=|\.assign\s*\(|\.replace\s*\()|document\.write|\.remove\s*\(\)|localStorage\.(setItem|removeItem|clear)|\.value\s*=[^=])/;

export class Tab {
  /** A Tab owns the page object bound to its identity; `bound` lets a caller (frozen tools) pass an existing page. */
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
    if (!url.startsWith('data:')) Policy.throwIfDenied(this.ctx.rt.policy.checkOrigin(url));
    return this.use(async (page) => {
      await page.goto(url, opts);
      this.ctx.state.trace.record({ kind: 'goto', url, page: this.id });
      await this.harvest(page, 'goto');
      return this.info(page);
    });
  }

  /**
   * API-first evidence: pull the requests this tab captured since the last pull (capture is on for every session tab)
   * into the session log and the trace, tagged with the step that triggered them. Best effort — never fails a step.
   */
  private async harvest(page: RuntimePage, after?: string): Promise<Array<Record<string, unknown> & { seq: number }>> {
    // best effort: harvesting must never fail the step that just succeeded
    try { const captured = await page.readNetworkCapture().catch(() => [] as unknown[]) as Array<Record<string, unknown>>; return this.logNetwork(captured, after); } catch { return []; }
  }
  private logNetwork(entries: Array<Record<string, unknown>>, after?: string): Array<Record<string, unknown> & { seq: number }> {
    let log = this.ctx.state.netLog.get(this.id);
    if (!log) { log = { seq: 0, entries: [], seen: new Set() }; this.ctx.state.netLog.set(this.id, log); }
    const fresh: Array<Record<string, unknown> & { seq: number }> = [];
    for (const e of entries) {
      const key = String(e.requestId ?? `${e.method ?? 'GET'} ${e.url ?? e.name ?? ''} ${e.timestamp ?? e.startTime ?? e.ts ?? ''}`);
      if (log.seen.has(key)) continue;
      log.seen.add(key);
      const entry = { ...e, seq: ++log.seq }; log.entries.push(entry); fresh.push(entry);
      // compile evidence lives in its own capped store, never in the step trace (so it can't evict a goto/act/expect)
      const ev = this.ctx.state.netEvidence; ev.push(networkEvent(e, this.id, after));
      if (ev.length > 800) ev.splice(0, ev.length - 800);
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
  async close(): Promise<void> { await this.use((p) => p.closeTab(this.id)); this.closed = true; this.ctx.rt.forgetPage(this.ctx.sessionId, this.id); }

  async observe(opts: ObserveOptions = {}): Promise<{ url: string | null; title: string | null; state?: string; diff?: boolean; changed?: { added: number; removed: number; changed?: number }; image?: ImageValue }> {
    const mode = opts.mode ?? 'state';
    return this.use(async (page) => {
      const meta = await this.info(page);
      const out: { url: string | null; title: string | null; state?: string; diff?: boolean; changed?: { added: number; removed: number; changed?: number }; image?: ImageValue } = { ...meta };
      if (mode === 'state' || mode === 'both') {
        // one state source: Playwright's aria snapshot (credential values redacted); its [ref=eN] are the act targets
        let text = String(await page.pageCall('aria', { viewport: Boolean(opts.viewport) }));
        const key = `${this.id}:${opts.viewport ? 'vp' : 'all'}`;
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
        out.state = text;
        this.ctx.state.trace.record({ kind: 'observe', mode: 'aria', page: this.id, summary: meta.title ?? undefined, sample: text.slice(0, 1500) });
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

  /** wait + act in one call at the runtime edge: locate → wait actionable → hit-test → real input → settle. */
  async act(opts: ActOptions): Promise<Record<string, unknown>> {
    const { action } = opts;
    return this.use(async (page) => {
      const record = (ok: boolean, extra: Record<string, unknown> = {}) => this.ctx.state.trace.record({ kind: 'act', action, target: describeTarget(opts.target), targetSpec: opts.target as Record<string, unknown> | undefined, targetSelector: typeof extra.selector === 'string' ? extra.selector : undefined, targetRef: typeof extra.ref === 'string' ? extra.ref : undefined, value: opts.value, matchLevel: extra.match_level as string | undefined, ok, page: this.id });
      try {
        // use the page already held by this.use(): calling this.reload()/back()/forward() here would re-enter the session lock and deadlock
        if (action === 'back' || action === 'forward' || action === 'reload') { const h = await page.history(action); record(true, { url: h.url }); return { action, ...h }; }
        if (action === 'scroll' && !opts.target) {
          // no target: wheel at the viewport centre
          const vp = await page.evaluate<{ x: number; y: number }>('({ x: innerWidth / 2, y: innerHeight / 2 })');
          opts = { ...opts, target: { x: vp.x, y: vp.y } };
        }
        if (!opts.target) throw new ActionError('missing_target', `action "${action}" needs a target`, 'Pass a target: a {ref} from observe, or a selector/role+name/label/text/testid.');
        const r = await page.act({ kind: action, target: opts.target as Record<string, unknown>, value: opts.value, files: opts.files, to: opts.to as Record<string, unknown> | undefined, direction: opts.direction, amount: opts.amount, timeoutMs: opts.timeoutMs, settleMs: opts.settleMs ?? 600, cursor: this.ctx.rt.cursorEnabled });
        record(true, { ...r, ref: r.ref ?? undefined });
        await this.harvest(page, action);
        // Lean result: only what changes the agent's next move. Full telemetry (point/method/timings/selector/…) is in the trace.
        return {
          action,
          ...(r.matches_n > 1 ? { matches_n: r.matches_n } : {}),
          ...(r.navigated ? { navigated: true, ...(r.url !== undefined && { url: r.url }) } : {}),
          ...(r.ref ? { ref: r.ref } : {}),
          ...(r.filled !== undefined ? { filled: r.filled, verified: r.verified, actual: r.actual } : {}),
          ...(r.checked !== undefined ? { checked: r.checked, changed: r.changed } : {}),
          ...(r.selected !== undefined ? { selected: r.selected } : {}),
          ...(r.files !== undefined ? { files: r.files } : {}),
        };
      } catch (err) {
        record(false);
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
    call: async (name: string, input: Record<string, unknown> = {}, opts: { confirm?: boolean } = {}): Promise<unknown> => this.use(async (p) => {
      if (this.ctx.rt.policy.confirmWrites) Policy.throwIfDenied(this.ctx.rt.policy.checkWrite(`webmcp ${name}`, Boolean(opts.confirm)));
      this.ctx.state.trace.record({ kind: 'note', text: `webmcp ${name}(${JSON.stringify(input).slice(0, 120)})`, page: this.id });
      return p.evaluateWithArgs(`(async () => { const mc = navigator.modelContext || document.modelContext; if (!mc) throw new Error('page exposes no modelContext'); if (typeof mc.executeTool === 'function') return await mc.executeTool(name, input); const tools = await mc.getTools(); const t = (tools || []).find(x => x.name === name); if (!t || typeof t.execute !== 'function') throw new Error('unknown page tool ' + name); return await t.execute(input); })()`, { name, input });
    }),
  };

  /** Assert what the page must show now (polled up to timeoutMs). Recorded in the trace so tools_compile emits it as a checkpoint. */
  async expect(what: Expectation, opts: { timeoutMs?: number } = {}): Promise<CheckResult> {
    return this.use(async (page) => {
      try { const r = await page.expect(what, opts); this.ctx.state.trace.record({ kind: 'expect', what: what as Record<string, unknown>, ok: true, page: this.id }); return r; }
      catch (err) { this.ctx.state.trace.record({ kind: 'expect', what: what as Record<string, unknown>, ok: false, page: this.id }); const e = err as { code?: string; message?: string; hint?: string; extra?: Record<string, unknown> }; throw new ActionError(e.code ?? 'expectation_failed', e.message ?? String(err), e.hint, e.extra); }
    });
  }

  /** Read-only page evaluation. */
  async evaluate(js: string, opts: { allowWrite?: boolean; frame?: number } = {}): Promise<unknown> {
    if (!opts.allowWrite && WRITE_EVAL_RE.test(js)) throw new ActionError('evaluate_read_only', 'evaluate is read-only; use act() for clicks, typing, navigation and form changes', 'Pass allowWrite:true only when the user explicitly wants a scripted page change.');
    return this.use(async (page) => {
      const result = await (opts.frame !== undefined ? page.evaluateInFrame(js, opts.frame) : page.evaluate(js));
      let sample: string | undefined; try { sample = JSON.stringify(result)?.slice(0, 2000); } catch { /* unserializable */ }
      this.ctx.state.trace.record({ kind: 'evaluate', code: js.slice(0, 200), page: this.id, ...(sample && { result: sample }) });
      return result;
    });
  }

  /** Native alert/confirm/prompt dialogs block the page; commands fail with `dialog_open` until answered. */
  readonly dialog = {
    get: async (): Promise<DialogInfo | null> => this.use(async (p) => (await p.dialog('get')).dialog),
    accept: async (text?: string): Promise<DialogInfo | null> => this.use(async (p) => { this.ctx.state.trace.record({ kind: 'note', text: `dialog accept${text !== undefined ? ' ' + JSON.stringify(text) : ''}`, page: this.id }); return (await p.dialog('accept', text)).dialog; }),
    dismiss: async (): Promise<DialogInfo | null> => this.use(async (p) => { this.ctx.state.trace.record({ kind: 'note', text: 'dialog dismiss', page: this.id }); return (await p.dialog('dismiss')).dialog; }),
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
   * Read one cookie's value at run time — the replay hook for per-request tokens a frozen tool needs (csrf/ct0/
   * csrftoken/XSRF-TOKEN). Defaults to the current page's host. Returns undefined when the cookie is absent.
   */
  async cookie(name: string, opts: { domain?: string } = {}): Promise<string | undefined> {
    let domain = opts.domain;
    if (!domain) { const u = await this.url().catch(() => null); try { domain = u ? new URL(u).hostname : undefined; } catch { domain = undefined; } }
    const list = await this.use((p) => p.getCookies(domain ? { domain } : {})) as Array<{ name?: string; value?: string }>;
    return list.find((c) => c?.name === name)?.value;
  }
  /** Fetch JSON through the page (its cookies, its origin) — the network-first way to freeze a site: find the endpoint, call it directly. */
  async fetchJson(url: string, opts: Record<string, unknown> = {}): Promise<unknown> { this.ctx.state.trace.record({ kind: 'note', text: `fetchJson ${url.slice(0, 160)}`, page: this.id }); return this.use((p) => p.fetchJson(url, opts as never)); }
  async frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string; crossOrigin?: boolean; oopif?: boolean }>> { return this.use((p) => p.frames()); }
  async download(pattern = '', timeoutMs = 30_000): Promise<unknown> { return this.use((p) => p.waitForDownload(pattern, timeoutMs)); }
}
