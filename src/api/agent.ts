/**
 * The object model — the single surface behind both the typed MCP tools and the `js` session.
 *   agent.browsers → browser.tabs / browser.user / browser.capabilities → tab.observe / tab.act / …
 *   sites.<site>.<command>(args) · recon.discover(tab) · tools.define/compile · session.name/finalize
 * Mirrors the shape ChatGPT's browser runtime exposes, on OpenCLI page semantics.
 */
import type { Runtime, SessionState } from '../runtime/runtime.js';
import type { RuntimePage } from '../backends/page-types.js';
import type { ExtensionRuntimePage, UserTabInfo } from '../backends/extension-page.js';
import { importDist } from '../lib/opencli.js';
import { lineDiff } from './diff.js';
import { ActionError } from './errors.js';
import { Policy } from '../runtime/policy.js';
import { discoverEndpoints, type DiscoverResult } from '../recon/discover.js';
import { compileFromTrace, listDefinedTools, type ToolDefinition } from '../sites/define.js';
import { buildInstructions, readDoc, type DocContext } from '../docs/manifest.js';

export type Target =
  | { ref: number | string }
  | { css: string; nth?: number }
  | { role?: string; name?: string; label?: string; text?: string; testid?: string; nth?: number }
  | { x: number; y: number };

export type ActAction = 'click' | 'dblclick' | 'hover' | 'focus' | 'fill' | 'type' | 'press' | 'select' | 'check' | 'uncheck' | 'upload' | 'drag' | 'scroll' | 'back' | 'forward' | 'reload';
type ActKindEdge = 'click' | 'dblclick' | 'hover' | 'focus' | 'fill' | 'type' | 'press' | 'check' | 'uncheck' | 'select';

export interface ActOptions { target?: Target; action: ActAction; value?: string; files?: string[]; to?: Target; direction?: 'up' | 'down' | 'left' | 'right'; amount?: number; timeoutMs?: number; settleMs?: number }

export interface ObserveOptions { mode?: 'state' | 'screenshot' | 'both'; source?: 'dom' | 'ax'; diff?: boolean; interactive?: boolean; compact?: boolean; maxDepth?: number; maxTextLength?: number; annotate?: boolean; fullPage?: boolean }

export interface ImageValue { __image: true; mimeType: string; base64: string }

type Lib = {
  waitForDomStableJs: (maxMs: number, quietMs: number) => string;
  formatSnapshot: (raw: string, opts?: Record<string, unknown>) => string;
  buildSemanticFindJs: (opts: Record<string, unknown>) => string;
  buildFindJs: (selector: string, opts?: Record<string, unknown>) => string;
  isFindError: (r: unknown) => r is { error: { code: string; message: string; hint?: string } };
  resolveTargetJs: (ref: string, opts?: Record<string, unknown>) => string;
  selectResolvedJs: (option: string) => string;
};
let libPromise: Promise<Lib> | null = null;
function lib(): Promise<Lib> {
  if (!libPromise) libPromise = Promise.all([importDist('snapshotFormatter.js'), importDist('browser/find.js'), importDist('browser/target-resolver.js'), importDist('browser/dom-helpers.js')])
    .then(([sf, fd, tr, dh]) => ({ waitForDomStableJs: dh.waitForDomStableJs, formatSnapshot: sf.formatSnapshot, buildSemanticFindJs: fd.buildSemanticFindJs, buildFindJs: fd.buildFindJs, isFindError: fd.isFindError, resolveTargetJs: tr.resolveTargetJs, selectResolvedJs: tr.selectResolvedJs }));
  return libPromise;
}

interface FindEntry { nth: number; ref: number; tag: string; role: string; text: string; attrs: Record<string, string>; visible: boolean; compound?: unknown }

function describeTarget(t: Target | undefined): string {
  if (!t) return '';
  if ('ref' in t) return `ref:${t.ref}`;
  if ('css' in t) return `css:${t.css}${t.nth !== undefined ? `[${t.nth}]` : ''}`;
  if ('x' in t) return `point:${t.x},${t.y}`;
  return Object.entries(t).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(' ');
}

const WRITE_EVAL_RE = /(\.click\s*\(|\.submit\s*\(|\blocation\s*(=|\.href\s*=|\.assign\s*\(|\.replace\s*\()|document\.write|\.remove\s*\(\)|localStorage\.(setItem|removeItem|clear)|\.value\s*=[^=])/;

export class Tab {
  constructor(readonly id: string, private readonly ctx: SessionContext) {}

  /** Run `fn` with this tab as the page's active identity. */
  async use<T>(fn: (page: RuntimePage) => Promise<T>): Promise<T> {
    const page = await this.ctx.rt.getBrowserPage(this.ctx.sessionId);
    if (page.getActivePage() !== this.id) page.setActivePage(this.id);
    return fn(page);
  }

  async goto(url: string, opts: { waitUntil?: 'load' | 'none'; settleMs?: number } = {}): Promise<{ url: string | null; title: string | null }> {
    if (!/^https?:\/\//i.test(url)) throw new ActionError('invalid_url', 'Only http(s) URLs can be opened', 'Pass an absolute http:// or https:// URL');
    Policy.throwIfDenied(this.ctx.rt.policy.checkOrigin(url));
    return this.use(async (page) => {
      await page.goto(url, opts);
      this.ctx.state.trace.record({ kind: 'goto', url, page: this.id });
      return this.info(page);
    });
  }
  private async info(page: RuntimePage): Promise<{ url: string | null; title: string | null }> {
    const url = await page.getCurrentUrl().catch(() => null);
    const title = await page.evaluate<string>('document.title').catch(() => null);
    return { url, title };
  }
  async url(): Promise<string | null> { return this.use((p) => p.getCurrentUrl()); }
  async title(): Promise<string | null> { return this.use((p) => p.evaluate<string>('document.title')); }
  async back(): Promise<void> { await this.use((p) => p.evaluate('history.back()')); }
  async forward(): Promise<void> { await this.use((p) => p.evaluate('history.forward()')); }
  async reload(): Promise<void> { await this.use((p) => p.evaluate('location.reload()')); await this.wait({ time: 1 }); }
  async close(): Promise<void> { await this.use((p) => p.closeTab(this.id)); }

  async observe(opts: ObserveOptions = {}): Promise<{ url: string | null; title: string | null; state?: string; diff?: boolean; changed?: { added: number; removed: number }; image?: ImageValue }> {
    const mode = opts.mode ?? 'state';
    const L = await lib();
    return this.use(async (page) => {
      const meta = await this.info(page);
      const out: { url: string | null; title: string | null; state?: string; diff?: boolean; changed?: { added: number; removed: number }; image?: ImageValue } = { ...meta };
      if (mode === 'state' || mode === 'both') {
        const snapOpts = { interactive: opts.interactive, compact: opts.compact ?? true, maxDepth: opts.maxDepth, maxTextLength: opts.maxTextLength, source: opts.source ?? this.ctx.rt.ablation.observeSource ?? 'dom' };
        const raw = await page.snapshot(snapOpts);
        let text = typeof raw === 'string' ? L.formatSnapshot(raw, snapOpts) : JSON.stringify(raw, null, 2);
        const key = `${this.id}:${snapOpts.source}`;
        const prev = this.ctx.state.lastObserve.get(key);
        this.ctx.state.lastObserve.set(key, text);
        const diffOn = opts.diff ?? this.ctx.rt.ablation.observeDiff !== false;
        if (diffOn && prev && prev !== text) {
          const d = lineDiff(prev, text);
          if (d.changedRatio < 0.6) { out.diff = true; out.changed = { added: d.added, removed: d.removed }; text = d.text || '(no visible change)'; }
        } else if (diffOn && prev === text) { out.diff = true; out.changed = { added: 0, removed: 0 }; text = '(unchanged since last observe)'; }
        out.state = text;
        this.ctx.state.trace.record({ kind: 'observe', mode: opts.source ?? 'dom', page: this.id, summary: meta.title ?? undefined });
      }
      if (mode === 'screenshot' || mode === 'both') out.image = await this.screenshot({ annotate: opts.annotate, fullPage: opts.fullPage });
      return out;
    });
  }

  async screenshot(opts: { fullPage?: boolean; annotate?: boolean; format?: 'png' | 'jpeg'; quality?: number } = {}): Promise<ImageValue> {
    return this.use(async (page) => {
      const b64 = opts.annotate ? await page.annotatedScreenshot({ fullPage: opts.fullPage, format: opts.format, quality: opts.quality }) : await page.screenshot({ fullPage: opts.fullPage, format: opts.format, quality: opts.quality });
      return { __image: true, mimeType: opts.format === 'jpeg' ? 'image/jpeg' : 'image/png', base64: b64 };
    });
  }

  async find(target: Target & { limit?: number }): Promise<{ matches_n: number; entries: FindEntry[] }> {
    const L = await lib();
    return this.use(async (page) => {
      const js = 'css' in target ? L.buildFindJs(target.css, { limit: target.limit ?? 20 }) : L.buildSemanticFindJs({ role: (target as { role?: string }).role, name: (target as { name?: string }).name, label: (target as { label?: string }).label, text: (target as { text?: string }).text, testid: (target as { testid?: string }).testid, limit: target.limit ?? 20 });
      const r = await page.evaluate(js);
      if (L.isFindError(r)) throw new ActionError(r.error.code, r.error.message, r.error.hint);
      return r as { matches_n: number; entries: FindEntry[] };
    });
  }

  private async resolveRef(target: Target, page: RuntimePage): Promise<{ ref: string; nth?: number; point?: { x: number; y: number } }> {
    const L = await lib();
    if ('x' in target) return { ref: '', point: { x: target.x, y: target.y } };
    if ('ref' in target) return { ref: String(target.ref) };
    if ('css' in target) return { ref: target.css, nth: target.nth };
    const js = L.buildSemanticFindJs({ role: target.role, name: target.name, label: target.label, text: target.text, testid: target.testid, limit: 20 });
    const r = await page.evaluate(js);
    if (L.isFindError(r)) throw new ActionError(r.error.code === 'semantic_not_found' ? 'not_found' : r.error.code, r.error.message, r.error.hint ?? 'Observe the page and pick a ref, or loosen the locator.');
    const { entries } = r as { matches_n: number; entries: FindEntry[] };
    const cands = entries.slice(0, 10).map((e) => ({ nth: e.nth, ref: e.ref, tag: e.tag, role: e.role, text: e.text, visible: e.visible }));
    if (target.nth !== undefined) {
      const e = entries[target.nth];
      if (!e) throw new ActionError('selector_nth_out_of_range', `nth=${target.nth} but only ${entries.length} matches`, undefined, { candidates: cands });
      return { ref: String(e.ref) };
    }
    const visible = entries.filter((e) => e.visible);
    if (visible.length === 1) return { ref: String(visible[0].ref) };
    if (entries.length === 1) return { ref: String(entries[0].ref) };
    if (visible.length === 0) throw new ActionError('not_visible', `${entries.length} matches but none visible`, 'Scroll or open the containing control, then retry.', { candidates: cands });
    throw new ActionError('selector_ambiguous', `${visible.length} visible matches for ${describeTarget(target)}`, 'Add nth, or use a ref from the candidates.', { candidates: cands });
  }

  private async moveCursorTo(page: RuntimePage, ref: string, nth?: number): Promise<void> {
    if (!this.ctx.rt.cursorEnabled || !this.ctx.rt.isExtensionPage(page)) return;
    try {
      const sel = /^\d+$/.test(ref) ? `[data-opencli-ref="${ref}"]` : ref;
      const pt = await page.evaluateWithArgs(`(() => { const els = document.querySelectorAll(sel); const el = els[nth] || els[0]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`, { sel, nth: nth ?? 0 }) as { x: number; y: number } | null;
      if (pt) await (page as ExtensionRuntimePage).cursor(pt.x, pt.y);
    } catch { /* overlay is best-effort */ }
  }

  /** wait + act in one call; real input events; branchable error codes. */
  async act(opts: ActOptions): Promise<Record<string, unknown>> {
    const L = await lib();
    const { action } = opts;
    return this.use(async (page) => {
      const record = (ok: boolean, extra: Record<string, unknown> = {}) => this.ctx.state.trace.record({ kind: 'act', action, target: describeTarget(opts.target), targetRef: typeof extra.ref === 'string' ? extra.ref : undefined, value: opts.value, matchLevel: extra.match_level as string | undefined, ok, page: this.id });
      // Runtime-edge path: one atomic command inside the extension (locate → wait → hit-test → real input → settle).
      const EDGE = new Set(['click', 'dblclick', 'hover', 'focus', 'fill', 'type', 'press', 'check', 'uncheck', 'select']);
      if (this.ctx.rt.ablation.actMode !== 'host' && this.ctx.rt.isExtensionPage(page) && EDGE.has(action) && opts.target) {
        try {
          const r = await page.act({ kind: action as ActKindEdge, target: opts.target as Record<string, unknown>, value: opts.value, timeoutMs: opts.timeoutMs, settleMs: opts.settleMs ?? this.ctx.rt.ablation.settleMs, cursor: this.ctx.rt.cursorEnabled });
          record(true, { ...r, ref: r.ref ?? undefined });
          return { action, target: describeTarget(opts.target), mode: 'extension', ...r, ok: true };
        } catch (err) {
          record(false);
          const e = err as { code?: string; message?: string; hint?: string; data?: unknown };
          throw new ActionError(e.code ?? 'action_failed', e.message ?? String(err), e.hint, e.data && typeof e.data === 'object' ? e.data as Record<string, unknown> : undefined);
        }
      }
      try {
        if (action === 'back' || action === 'forward' || action === 'reload') { await this[action](); record(true); return { ok: true, action }; }
        if (action === 'scroll' && !opts.target) { await page.scroll(opts.direction ?? 'down', opts.amount); record(true); return { ok: true, action, direction: opts.direction ?? 'down' }; }
        if (!opts.target) throw new ActionError('missing_target', `action "${action}" needs a target`);
        const resolved = await this.resolveRef(opts.target, page);
        if (resolved.point) {
          if (this.ctx.rt.isExtensionPage(page)) await page.cursor(resolved.point.x, resolved.point.y).catch(() => {});
          if (action === 'click') await page.nativeClick(resolved.point.x, resolved.point.y);
          else if (action === 'hover') await (page as unknown as { tryNativeMouseMove?: (x: number, y: number) => Promise<boolean> }).tryNativeMouseMove?.(resolved.point.x, resolved.point.y);
          else throw new ActionError('unsupported_target', `action "${action}" does not support point targets`);
          record(true, { ref: 'point' });
          await this.settle(page, opts.settleMs);
          return { ok: true, action, point: resolved.point, method: 'cdp' };
        }
        const { ref, nth } = resolved;
        const ro = nth !== undefined ? { nth } : undefined;
        await this.moveCursorTo(page, ref, nth);
        let result: Record<string, unknown>;
        switch (action) {
          case 'click': result = await page.click(ref, ro) as Record<string, unknown>; break;
          case 'dblclick': result = await page.dblClick!(ref, ro) as Record<string, unknown>; break;
          case 'hover': result = await page.hover!(ref, ro) as Record<string, unknown>; break;
          case 'focus': result = await page.focus!(ref, ro) as Record<string, unknown>; break;
          case 'fill': result = await page.fillText(ref, opts.value ?? '', ro) as unknown as Record<string, unknown>; break;
          case 'type': result = await page.typeText(ref, opts.value ?? '', ro) as Record<string, unknown>; break;
          case 'press': { const f = await page.focus!(ref, ro); await page.pressKey(opts.value ?? 'Enter'); result = { ...(f as Record<string, unknown>), key: opts.value ?? 'Enter' }; break; }
          case 'check': case 'uncheck': result = await page.setChecked!(ref, action === 'check', ro) as unknown as Record<string, unknown>; break;
          case 'upload': result = await page.uploadFiles!(ref, opts.files ?? [], ro) as unknown as Record<string, unknown>; break;
          case 'select': {
            const rs = await page.evaluate(L.resolveTargetJs(ref, ro)) as Record<string, unknown>;
            if (rs && (rs as { error?: unknown }).error) { const e = (rs as { error: { code: string; message: string; hint?: string } }).error; throw new ActionError(e.code, e.message, e.hint); }
            const sel = await page.evaluate(L.selectResolvedJs(opts.value ?? '')) as Record<string, unknown>;
            if (sel && (sel as { error?: unknown }).error) { const e = (sel as { error: { code: string; message: string; hint?: string; available?: string[] } }).error; throw new ActionError(e.code, e.message, e.hint, e.available ? { available: e.available } : undefined); }
            result = { ...(rs ?? {}), ...(sel ?? {}) }; break;
          }
          case 'drag': {
            if (!opts.to) throw new ActionError('missing_target', 'drag needs `to`');
            const to = await this.resolveRef(opts.to, page);
            result = await page.drag!(ref, to.ref, { from: ro, to: to.nth !== undefined ? { nth: to.nth } : undefined }) as unknown as Record<string, unknown>; break;
          }
          case 'scroll': result = (await page.scrollTo(ref, ro) as Record<string, unknown>) ?? {}; break;
          default: throw new ActionError('unsupported_action', `unknown action "${String(action)}"`);
        }
        record(true, { ...result, ref });
        await this.settle(page, opts.settleMs);
        return { ok: true, action, target: describeTarget(opts.target), ref, ...result };
      } catch (err) {
        record(false);
        if (err instanceof ActionError) throw err;
        const e = err as { message?: string; code?: string; hint?: string };
        const msg = e.message ?? String(err);
        const code = e.code ?? (/not found|no element/i.test(msg) ? 'not_found' : /stale/i.test(msg) ? 'stale_ref' : /ambiguous|multiple/i.test(msg) ? 'selector_ambiguous' : /intercept|covered|obscur/i.test(msg) ? 'intercepted' : /timed? ?out/i.test(msg) ? 'timeout' : 'action_failed');
        throw new ActionError(code, msg, e.hint);
      }
    });
  }

  /** After an action, wait briefly until the DOM stops mutating (Codex-style auto-wait) so the next observe is current. */
  private async settle(page: RuntimePage, settleMs = 600): Promise<void> {
    if (settleMs <= 0) return;
    const L = await lib();
    try { await page.evaluate(L.waitForDomStableJs(settleMs, Math.min(200, settleMs))); } catch { /* navigation in flight — fine */ }
  }

  /** WebMCP: tools the page itself registers via navigator.modelContext (page-provided tool source). */
  readonly webmcp = {
    list: async (): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> => this.use(async (p) => {
      const r = await p.evaluate(`(async () => { const mc = navigator.modelContext || document.modelContext; if (!mc || typeof mc.getTools !== 'function') return []; const tools = await mc.getTools(); return (tools || []).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })); })()`);
      return Array.isArray(r) ? r as Array<{ name: string; description?: string; inputSchema?: unknown }> : [];
    }),
    call: async (name: string, input: Record<string, unknown> = {}): Promise<unknown> => this.use(async (p) => {
      this.ctx.state.trace.record({ kind: 'note', text: `webmcp ${name}(${JSON.stringify(input).slice(0, 120)})`, page: this.id });
      return p.evaluateWithArgs(`(async () => { const mc = navigator.modelContext || document.modelContext; if (!mc) throw new Error('page exposes no modelContext'); if (typeof mc.executeTool === 'function') return await mc.executeTool(name, input); const tools = await mc.getTools(); const t = (tools || []).find(x => x.name === name); if (!t || typeof t.execute !== 'function') throw new Error('unknown page tool ' + name); return await t.execute(input); })()`, { name, input });
    }),
  };

  async wait(opts: { text?: string; selector?: string; url?: string; time?: number; timeout?: number } = {}): Promise<{ ok: true }> {
    return this.use(async (page) => {
      if (opts.url) {
        const deadline = Date.now() + (opts.timeout ?? 15) * 1000;
        for (;;) { const u = await page.getCurrentUrl(); if (u && u.includes(opts.url)) break; if (Date.now() > deadline) throw new ActionError('timeout', `URL did not include "${opts.url}" within ${opts.timeout ?? 15}s`); await page.sleep(0.25); }
        return { ok: true as const };
      }
      await page.wait({ text: opts.text, selector: opts.selector, time: opts.time, timeout: opts.timeout });
      return { ok: true as const };
    });
  }

  /** Read-only page evaluation. */
  async evaluate(js: string, opts: { allowWrite?: boolean; frame?: number } = {}): Promise<unknown> {
    if (!opts.allowWrite && WRITE_EVAL_RE.test(js)) throw new ActionError('evaluate_read_only', 'evaluate is read-only; use act() for clicks, typing, navigation and form changes', 'Pass allowWrite:true only when the user explicitly wants a scripted page change.');
    this.ctx.state.trace.record({ kind: 'evaluate', code: js.slice(0, 200), page: this.id });
    return this.use((page) => opts.frame !== undefined ? page.evaluateInFrame(js, opts.frame) : page.evaluate(js));
  }

  readonly network = {
    start: async (pattern = ''): Promise<boolean> => this.use((p) => p.startNetworkCapture(pattern)),
    read: async (opts: { pattern?: string; limit?: number; includeStatic?: boolean } = {}): Promise<unknown[]> => this.use(async (p) => {
      const captured = await p.readNetworkCapture().catch(() => [] as unknown[]);
      const entries = captured.length ? captured : await p.networkRequests(opts.includeStatic ?? false);
      const list = (entries as Array<Record<string, unknown>>).filter((e) => !opts.pattern || String(e.url ?? e.name ?? '').includes(opts.pattern));
      for (const e of list.slice(0, 50)) this.ctx.state.trace.record({ kind: 'network', url: String(e.url ?? e.name ?? ''), method: e.method as string | undefined, status: e.status as number | undefined, contentType: (e.contentType ?? e.mimeType) as string | undefined, bodyBytes: typeof e.responseBody === 'string' ? (e.responseBody as string).length : undefined, page: this.id });
      return list.slice(0, opts.limit ?? 100);
    }),
  };
  async cookies(domain: string): Promise<unknown[]> { return this.use((p) => p.getCookies({ domain })); }
  async frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string }>> { return this.use((p) => p.frames()); }
  async download(pattern = '', timeoutMs = 30_000): Promise<unknown> { return this.use((p) => p.waitForDownload(pattern, timeoutMs)); }
  async markDeliverable(): Promise<void> { await this.mark('deliverable'); }
  async markHandoff(): Promise<void> { await this.mark('handoff'); }
  private async mark(mark: 'deliverable' | 'handoff'): Promise<void> {
    await this.use(async (p) => { if (this.ctx.rt.isExtensionPage(p)) await p.mark(this.id, mark); });
  }
}

export interface SessionContext { rt: Runtime; sessionId: string; state: SessionState }

export class Browser {
  constructor(readonly id: 'chrome' | 'cdp', readonly type: 'extension' | 'cdp', private readonly ctx: SessionContext) {}
  private page(): Promise<RuntimePage> { return this.ctx.rt.getBrowserPage(this.ctx.sessionId); }
  private ext(page: RuntimePage): ExtensionRuntimePage {
    if (!this.ctx.rt.isExtensionPage(page)) throw new ActionError('unsupported_backend', 'This operation needs the Chrome extension backend');
    return page;
  }

  readonly tabs = {
    new: async (url?: string): Promise<Tab> => {
      const page = await this.page();
      if (url && !/^https?:\/\//i.test(url)) throw new ActionError('invalid_url', 'Only http(s) URLs can be opened');
      if (url) Policy.throwIfDenied(this.ctx.rt.policy.checkOrigin(url));
      if (!page.getActivePage() && url) { await page.goto(url); }
      else { const id = await page.newTab(url); if (id) page.setActivePage(id); if (url) await page.wait({ time: 0.5 }).catch(() => {}); }
      const id = page.getActivePage();
      if (!id) throw new ActionError('tab_create_failed', 'Could not create a tab');
      this.ctx.state.trace.record({ kind: 'goto', url: url ?? 'about:blank', page: id });
      return new Tab(id, this.ctx);
    },
    list: async (): Promise<Array<{ id: string; url?: string; title?: string; active?: boolean }>> => {
      const page = await this.page();
      const tabs = await page.tabs() as Array<{ page?: string; url?: string; title?: string; active?: boolean }>;
      return tabs.filter((t) => t.page).map((t) => ({ id: t.page!, url: t.url, title: t.title, active: t.active }));
    },
    get: (id: string): Tab => new Tab(id, this.ctx),
    selected: async (): Promise<Tab | undefined> => { const page = await this.page(); const id = page.getActivePage(); return id ? new Tab(id, this.ctx) : undefined; },
    finalize: async (opts: { keep?: Array<{ tab: string | Tab; status: 'deliverable' | 'handoff' }> } = {}): Promise<{ closed: string[]; kept: string[] }> => {
      const page = await this.page();
      const keep = (opts.keep ?? []).map((k) => ({ page: typeof k.tab === 'string' ? k.tab : k.tab.id, status: k.status }));
      this.ctx.state.finalized = true;
      if (this.ctx.rt.isExtensionPage(page)) return page.finalize(keep);
      await page.closeWindow();
      return { closed: [], kept: keep.map((k) => k.page) };
    },
  };

  readonly user = {
    openTabs: async (): Promise<UserTabInfo[]> => this.ext(await this.page()).userTabs(),
    claimTab: async (tab: { tabId: number; title?: string; url?: string }): Promise<Tab> => {
      if (tab.url) Policy.throwIfDenied(this.ctx.rt.policy.checkOrigin(tab.url));
      const page = this.ext(await this.page());
      const r = await page.claim(tab);
      this.ctx.state.trace.record({ kind: 'note', text: `claimed user tab ${tab.tabId} ${r.url ?? ''}` });
      return new Tab(r.page, this.ctx);
    },
  };

  async nameSession(name: string): Promise<void> {
    this.ctx.state.name = name;
    const page = await this.page();
    if (this.ctx.rt.isExtensionPage(page)) await page.nameSession(name);
  }

  readonly capabilities = {
    list: async (): Promise<Array<{ id: string; description: string }>> => {
      const base = [
        { id: 'cdp', description: 'Raw Chrome DevTools Protocol on the current tab (allowlisted methods).' },
        { id: 'viewport', description: 'Temporarily override the viewport size for responsive checks; reset when done.' },
        { id: 'webmcp', description: 'Tools the current page registers itself (navigator.modelContext); prefer them over clicking through the DOM.' },
      ];
      if (this.type === 'extension') base.push({ id: 'visibility', description: 'Show or hide the session window to the user. Default: background.' });
      return base;
    },
    get: async (id: string): Promise<Record<string, unknown>> => {
      const page = await this.page();
      this.ctx.state.capabilities.add(id);
      if (id === 'cdp') return { send: (method: string, params?: Record<string, unknown>) => page.cdp(method, params), documentation: () => readDoc('capabilities/cdp') };
      if (id === 'viewport') return { set: ({ width, height }: { width: number; height: number }) => page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }), reset: () => page.cdp('Emulation.clearDeviceMetricsOverride', {}) };
      if (id === 'visibility') { const ext = this.ext(page); return { get: () => ext.getVisibility(), set: (v: boolean) => ext.setVisibility(v), documentation: () => readDoc('capabilities/visibility') }; }
      if (id === 'webmcp') { const sel = await this.tabs.selected(); if (!sel) throw new ActionError('no_tab', 'Open a tab first'); return { list: () => sel.webmcp.list(), call: (name: string, input?: Record<string, unknown>) => sel.webmcp.call(name, input), documentation: () => readDoc('capabilities/webmcp') }; }
      throw new ActionError('unknown_capability', `no capability "${id}"`);
    },
  };

  documentation(): string {
    const ctx: DocContext = { backend: this.type, capabilities: [...this.ctx.state.capabilities] };
    return `${buildInstructions(ctx)}\n\n${readDoc('js-tool') ?? ''}`;
  }
}

export interface AgentApi {
  agent: { browsers: { list(): Promise<Array<{ id: string; type: string; connected: boolean }>>; get(id: string): Promise<Browser>; getDefault(): Promise<Browser>; getForUrl(url: string): Promise<Browser> }; documentation: { get(name: string): string | null } };
  sites: Record<string, unknown> & { search(q: string, limit?: number): unknown; list(): unknown; enable(site: string, opts?: { write?: boolean }): { site: string; tools: string[] }; disable(site: string): boolean; run(site: string, name: string, args?: Record<string, unknown>): Promise<unknown> };
  recon: { discover(tab: Tab, opts?: Parameters<typeof discoverEndpoints>[1]): Promise<DiscoverResult> };
  tools: { define(def: ToolDefinition): Promise<{ file: string; site: string; name: string }>; compile(opts: Parameters<typeof compileFromTrace>[1]): ToolDefinition; list(): ReturnType<typeof listDefinedTools>; remove(site: string, name: string): boolean };
  session: { id: string; name(n: string): Promise<void>; finalize(keep?: Array<{ tab: string | Tab; status: 'deliverable' | 'handoff' }>): Promise<unknown>; trace(): unknown[]; clearTrace(): void; runtimeAblation(): Record<string, unknown> };
}

export function createAgentApi(rt: Runtime, sessionId: string): AgentApi {
  const state = rt.session(sessionId);
  const ctx: SessionContext = { rt, sessionId, state };
  const browserFor = (id: string): Browser => {
    const backend = rt.backend();
    if (id === 'chrome' || id === 'extension') { if (backend !== 'extension') throw new ActionError('browser_unavailable', 'Chrome extension backend is not connected', 'Run doctor; make sure Chrome is running with the opencli-mcp extension.'); return new Browser('chrome', 'extension', ctx); }
    if (id === 'cdp') { if (backend !== 'cdp' && !rt.cdpEndpoint) throw new ActionError('browser_unavailable', 'No CDP endpoint configured', 'Set OPENCLI_CDP_ENDPOINT.'); return new Browser('cdp', 'cdp', ctx); }
    throw new ActionError('unknown_browser', `no browser "${id}"`);
  };
  const getDefault = async (): Promise<Browser> => {
    const b = rt.backend();
    if (b === 'none') throw new ActionError('browser_unavailable', 'No browser backend is connected', 'Run doctor. Site commands with strategy `public` still work without a browser.');
    return browserFor(b === 'extension' ? 'chrome' : 'cdp');
  };

  const siteBase = {
    search: (q: string, limit = 20) => rt.registry.search(q, limit),
    list: () => rt.registry.sites(),
    enable: (site: string, opts: { write?: boolean } = {}) => {
      if (!rt.registry.has(site)) throw new ActionError('unknown_site', `no site "${site}"`, 'Use sites.search() to find the right name.');
      state.enabledSites.set(site, { write: Boolean(opts.write) });
      rt.emit('tools-changed', { site });
      const tools = rt.registry.commands(site).filter((c) => opts.write || c.access === 'read').map((c) => `${site}_${c.name}`.replace(/[^A-Za-z0-9_-]/g, '_'));
      return { site, tools };
    },
    disable: (site: string) => { const ok = state.enabledSites.delete(site); if (ok) rt.emit('tools-changed', { site }); return ok; },
    run: async (site: string, name: string, args: Record<string, unknown> = {}) => {
      const { confirm, ...rest } = args as { confirm?: boolean } & Record<string, unknown>;
      const cmd = await rt.registry.resolve(site, name);
      if (cmd.access === 'write') Policy.throwIfDenied(rt.policy.checkWrite(`${site}/${name}`, Boolean(confirm)));
      const r = await rt.runSite(sessionId, site, name, rest);
      if (!r.ok) throw new ActionError(r.error.code, r.error.message, r.error.hint, { site, command: name });
      return r.rows ?? r.value;
    },
  };
  const sites = new Proxy(siteBase as AgentApi['sites'], {
    get(target, prop) {
      if (typeof prop !== 'string' || prop in target) return Reflect.get(target, prop);
      if (!rt.registry.has(prop)) return undefined;
      return new Proxy({}, { get: (_t, cmd) => typeof cmd === 'string' ? (args: Record<string, unknown> = {}) => siteBase.run(prop, cmd.replace(/_/g, '-'), args) : undefined });
    },
    has(target, prop) { return typeof prop === 'string' && (prop in target || rt.registry.has(prop)); },
  });

  return {
    agent: {
      browsers: {
        list: async () => [
          { id: 'chrome', type: 'extension', connected: rt.backend() === 'extension' },
          ...(rt.cdpEndpoint ? [{ id: 'cdp', type: 'cdp', connected: true }] : []),
        ],
        get: async (id: string) => browserFor(id),
        getDefault,
        getForUrl: async (url: string) => { try { const h = new URL(url).hostname; if ((h === 'localhost' || h === '127.0.0.1') && rt.cdpEndpoint) return browserFor('cdp'); } catch { /* fall through */ } return getDefault(); },
      },
      documentation: { get: (name: string) => readDoc(name) },
    },
    sites,
    recon: { discover: (tab: Tab, opts) => tab.use((page) => discoverEndpoints(page, opts)) },
    tools: {
      define: (def: ToolDefinition) => rt.defineTool(def),
      compile: (opts) => compileFromTrace(state.trace.events, opts),
      list: () => listDefinedTools(),
      remove: (site: string, name: string) => rt.removeTool(site, name),
    },
    session: {
      id: sessionId,
      name: async (n: string) => { const b = await getDefault(); await b.nameSession(n); },
      finalize: async (keep = []) => { const b = await getDefault(); return b.tabs.finalize({ keep }); },
      trace: () => state.trace.events,
      clearTrace: () => state.trace.clear(),
      /** Ablation toggles (mutable at runtime for experiments): actMode, observeDiff, observeSource, settleMs, refRescue. */
      runtimeAblation: () => rt.ablation as unknown as Record<string, unknown>,
    },
  };
}
