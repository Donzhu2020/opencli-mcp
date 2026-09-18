/**
 * Page-side module of the interaction engine. Bundled by esbuild and installed in the extension's isolated world of
 * every frame, next to Playwright's InjectedScript (globalThis.__opencliInjected). Exposes plain functions on
 * globalThis.__opencliPage; the host calls them with JSON arguments. Nothing here is assembled from strings, so this
 * file is type-checked and unit-tested like any other module (tests run it under jsdom with a stub engine).
 */
import {
  ACT_MARK, FRAME_MARK, ENGINE_GLOBAL, PAGE_GLOBAL,
  type ResolveArgs, type ResolveOutcome, type Candidate, type FindArgs, type FindResult, type FindEntry,
  type AriaArgs, type PointInfo, type FrameProbeResult, type SettleArgs, type SelectResult, type ElementAtResult, type Box, type Expectation, type CheckResult,
} from '../../../src/shared/page-contract.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Injected = any;

function injected(): Injected {
  const i = (globalThis as any)[ENGINE_GLOBAL];
  if (!i) throw new Error('engine_missing');
  return i;
}

function query(selector: string, root: Node = document): Element[] {
  const i = injected();
  return i.querySelectorAll(i.parseSelector(selector), root) as Element[];
}

/** Playwright's elementState throws for states that do not apply (e.g. 'checked' on a text input): read that as "not in this state". */
function stateOf(el: Element, name: string): { matches: boolean; received: string } {
  try { const r = injected().elementState(el, name); return { matches: r.matches === true, received: String(r.received ?? '') }; } catch (e) { return { matches: false, received: 'error:' + ((e as Error)?.message || String(e)) }; }
}
const is = (el: Element, name: string): boolean => stateOf(el, name).matches;

function box(el: Element): Box { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }
const text = (el: Element): string => ((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim();

function replaySelector(el: Element): string | null {
  try { return injected().generateSelector(el, { testIdAttributeName: 'data-testid' }).selector as string; } catch { return null; }
}
function roleOf(el: Element): string {
  try { const u = injected().utils; return (u?.getAriaRole && u.getAriaRole(el)) || el.getAttribute('role') || ''; } catch { return el.getAttribute('role') || ''; }
}
function nameOf(el: Element): string {
  try { const u = injected().utils; return u?.getElementAccessibleNameText ? String(u.getElementAccessibleNameText(el, false) || '') : ''; } catch { return ''; }
}

// ── aria refs: the one ref space (eN from the last aria snapshot) ──
let refIndexFor: WeakMap<object, Map<Element, string>> = new WeakMap();
function lastSnapshot(): { info?: Map<string, { element: Element }> } | null {
  try { return injected()._lastAriaSnapshotForQuery ?? null; } catch { return null; }
}
/** eN of an element in the most recent aria snapshot, or null. */
export function ariaRefOf(el: Element): string | null {
  const snap = lastSnapshot();
  if (!snap?.info) return null;
  let index = refIndexFor.get(snap);
  if (!index) { index = new Map(); for (const [ref, v] of snap.info) if (v?.element) index.set(v.element, ref); refIndexFor.set(snap, index); }
  return index.get(el) ?? null;
}

const candidate = (el: Element): Candidate => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', text: text(el).slice(0, 80), ref: ariaRefOf(el), visible: is(el, 'visible'), box: box(el) });

const actEl = (): Element | null => document.querySelector(`[${ACT_MARK}]`);
function markAct(el: Element): void { document.querySelectorAll(`[${ACT_MARK}]`).forEach((n) => n.removeAttribute(ACT_MARK)); el.setAttribute(ACT_MARK, '1'); }
export function clearActMark(): void { document.querySelectorAll(`[${ACT_MARK}]`).forEach((n) => n.removeAttribute(ACT_MARK)); }

const ALIGN_BLOCKS = new Set(['start', 'center', 'end', 'nearest']);

/** Locate → strict/unique-visible → states → scroll → wall-clock stable box → hit-test → mark. */
export async function resolve(args: ResolveArgs): Promise<ResolveOutcome> {
  const { selector, fallback, strict, states, align } = args;
  let usedSelector = selector;
  let matches = query(selector);
  if (!matches.length && fallback) { usedSelector = fallback; matches = query(fallback); }
  if (!matches.length) return { error: { code: 'not_found', message: `no element matches ${selector}` }, retry: true };
  let el = matches[0];
  if (matches.length > 1 && strict) {
    const visible = matches.filter((m) => is(m, 'visible'));
    if (visible.length === 1) el = visible[0];
    else return { error: { code: 'selector_ambiguous', message: `${matches.length} elements match ${selector}${visible.length ? ` (${visible.length} visible)` : ''}`, hint: 'Add nth, use a more specific locator, or act on a ref/selector from find.', candidates: matches.slice(0, 8).map(candidate) }, retry: false };
  }
  for (const st of states) {
    const r = stateOf(el, st);
    if (r.received === 'error:notconnected') return { error: { code: 'stale_ref', message: 'element detached during resolution' }, retry: true };
    if (!r.matches) return { error: { code: st === 'visible' ? 'not_visible' : st === 'enabled' ? 'not_enabled' : 'not_editable', message: `element is not ${st}${r.received.startsWith('error:') ? ` (${r.received.slice(6)})` : ''}`, candidates: [candidate(el)] }, retry: true };
  }
  try { el.scrollIntoView({ block: (ALIGN_BLOCKS.has(align.block) ? align.block : 'center') as ScrollLogicalPosition, inline: (ALIGN_BLOCKS.has(align.inline) ? align.inline : 'nearest') as ScrollLogicalPosition, behavior: 'instant' as ScrollBehavior }); } catch { /* not scrollable */ }
  // stable bounding box by wall clock: requestAnimationFrame is paused in background tabs
  let prev: string | null = null; let stable = 0; const t0 = performance.now();
  for (;;) {
    const r = el.getBoundingClientRect(); const cur = [r.left, r.top, r.width, r.height].map(Math.round).join(',');
    stable = prev === cur ? stable + 1 : 0; prev = cur;
    if (stable >= 1 || performance.now() - t0 > 700) break;
    await new Promise((res) => setTimeout(res, 40));
  }
  for (const st of states) if (!is(el, st)) return { error: { code: `not_${st}`, message: `element is not ${st} after scrolling` }, retry: true };
  const b = el.getBoundingClientRect();
  if (b.width <= 0 || b.height <= 0) return { error: { code: 'not_visible', message: 'element has no clickable box' }, retry: true };
  const x = Math.max(0, b.left + b.width / 2), y = Math.max(0, b.top + b.height / 2);
  if (x > innerWidth || y > innerHeight) return { error: { code: 'not_visible', message: 'element is outside the viewport' }, retry: true };
  const tag = el.tagName.toLowerCase();
  const type = (el as HTMLInputElement).type;
  const checkable = (tag === 'input' && (type === 'checkbox' || type === 'radio')) || ['checkbox', 'radio', 'switch'].includes(el.getAttribute('role') || '');
  const hit = injected().expectHitTarget({ x, y }, el);
  markAct(el);
  return {
    ok: true, x, y, matches_n: matches.length, tag,
    hit: hit === 'done' ? 'target' : 'other',
    blocker: hit === 'done' ? null : (hit && hit.hitTargetDescription) || 'another element',
    editable: is(el, 'editable'), checkable, checked: checkable ? is(el, 'checked') : false, isSelect: tag === 'select',
    ref: ariaRefOf(el), selector: replaySelector(el), usedSelector,
  };
}

/** Mark the element under a viewport point for a point-targeted action. */
export function pointInfo(args: { x: number; y: number }): PointInfo | null {
  const el = document.elementFromPoint(args.x, args.y);
  if (!el) return null;
  markAct(el);
  const tag = el.tagName.toLowerCase();
  const editable = Boolean((el as HTMLElement).isContentEditable || ((tag === 'input' || tag === 'textarea') && !(el as HTMLInputElement).readOnly && !(el as HTMLInputElement).disabled));
  return { tag, editable, isSelect: tag === 'select' };
}

// ── actions on the marked element ──
const target = (): Element => { const el = actEl(); if (!el) throw new Error('error:notconnected'); return el; };
const retarget = (el: Element): Element => (injected().retarget(el, 'follow-label') as Element | null) || el;

export function focus(): string {
  const el = actEl(); if (!el) return 'error:notconnected';
  return String(injected().focusNode(retarget(el), false));
}
export function readValue(): string | null {
  const el = actEl(); if (!el) return null;
  const t = retarget(el) as HTMLInputElement;
  return (t as HTMLElement).isContentEditable ? (t.textContent ?? '') : (t.value ?? null);
}
/** Playwright's fill: 'done' (value set for date/color/range…), 'needsinput' (focused + selected, host must insert text), or 'error:…'. */
export function fill(args: { value: string }): string {
  const el = actEl(); if (!el) return 'error:notconnected';
  try { return String(injected().fill(el, args.value)); } catch (e) { return 'error:' + ((e as Error)?.message || String(e)); }
}
/** React/Vue controlled inputs that swallow insertText: native setter + input event. */
export function nativeSet(args: { value: string }): boolean {
  const el = actEl(); if (!el) return false;
  const t = retarget(el) as HTMLInputElement | HTMLTextAreaElement;
  if ((t as HTMLElement).isContentEditable) { t.textContent = args.value; }
  else {
    const proto = t.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (set) set.call(t, args.value); else t.value = args.value;
  }
  t.dispatchEvent(new Event('input', { bubbles: true }));
  t.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}
export function isChecked(): boolean | null { const el = actEl(); if (!el) return null; const r = stateOf(el, 'checked'); return r.received.startsWith('error:') ? null : r.matches; }
export function select(args: { value: string }): SelectResult {
  const el = actEl(); if (!el) return { error: 'gone' };
  const i = injected();
  let r = i.selectOptions(el, [{ valueOrLabel: args.value }]);
  if (r === 'error:optionsnotfound' && /^\d+$/.test(args.value)) r = i.selectOptions(el, [{ index: Number(args.value) }]);
  if (typeof r === 'string' && r.startsWith('error:')) {
    const available = [...(el as HTMLSelectElement).options ?? []].map((o) => o.label || o.value).slice(0, 50);
    return { error: r.slice(6), available };
  }
  return { selected: Array.isArray(r) ? r.map(String) : [] };
}
export function caretToEnd(): void {
  const el = document.activeElement as HTMLInputElement | null;
  if (el && !(el as HTMLElement).isContentEditable && typeof el.setSelectionRange === 'function') { try { const n = el.value.length; el.setSelectionRange(n, n); } catch { /* not a text control */ } }
}
export function isFileInput(): boolean { const el = actEl(); return !!el && el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'file'; }
/** Re-mark the file input associated with the target (inside it, its label's control, or the nearest form). */
export function useAssociatedFileInput(): boolean {
  const el = actEl(); if (!el) return false;
  const control = (el as HTMLLabelElement).control as HTMLInputElement | null | undefined;
  const inp = el.querySelector('input[type=file]') || (control && control.type === 'file' ? control : null) || (el.closest('form,body') || document.body).querySelector('input[type=file]');
  if (!inp) return false;
  markAct(inp);
  return true;
}

/** Wait until the DOM has been quiet for `quietMs` (or `maxMs` elapsed). */
export function settle(args: SettleArgs): Promise<{ waitedMs: number; quiet: boolean }> {
  return new Promise((resolveP) => {
    const t0 = performance.now();
    let timer: ReturnType<typeof setTimeout>;
    const finish = (quiet: boolean) => { obs.disconnect(); clearTimeout(cap); resolveP({ waitedMs: Math.round(performance.now() - t0), quiet }); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => finish(true), args.quietMs); };
    const obs = new MutationObserver(arm);
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    const cap = setTimeout(() => { clearTimeout(timer); finish(false); }, args.maxMs);
    arm();
  });
}

// ── frames ──
export function frameProbe(args: { step: string | number }): FrameProbeResult {
  document.querySelectorAll(`[${FRAME_MARK}]`).forEach((n) => n.removeAttribute(FRAME_MARK));
  const list = typeof args.step === 'number' ? [...document.querySelectorAll('iframe,frame')] : query(args.step);
  const fe = (typeof args.step === 'number' ? list[args.step] : list[0]) as HTMLIFrameElement | undefined;
  if (!fe) return { found: false };
  let sameOrigin = false; try { sameOrigin = Boolean(fe.contentWindow && fe.contentWindow.document); } catch { sameOrigin = false; }
  try { fe.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior }); } catch { /* not scrollable */ }
  fe.setAttribute(FRAME_MARK, '1');
  const r = fe.getBoundingClientRect();
  return { found: true, sameOrigin, x: r.left + fe.clientLeft, y: r.top + fe.clientTop, src: fe.src || '' };
}
export function clearFrameMark(): void { document.querySelectorAll(`[${FRAME_MARK}]`).forEach((n) => n.removeAttribute(FRAME_MARK)); }

// ── observation: the aria snapshot is the one state source ──
const CRED = /user[-_ ]?name|e[-_ ]?mail|one[-_ ]?time[-_ ]?code|password|passcode|passwd|\botp\b|\b(?:2fa|mfa)\b|phone|mobile|\btel\b|\bcc-|cvc|cvv|csc|card|credit|payment|security[-_ ]?code|\biban\b|account[-_ ]?number|routing|ssn|social[-_ ]?security/i;
/** Credential fields never expose their value to the model (the ChatGPT plugin's rule). */
export function isCredentialField(el: Element): boolean {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
  if ((el as HTMLInputElement).type === 'password') return true;
  const hay = ['type', 'autocomplete', 'id', 'name', 'placeholder', 'aria-label', 'title'].map((a) => el.getAttribute(a) || '').join(' ');
  return CRED.test(hay);
}
function intersectsViewport(el: Element): boolean {
  const vw = window.visualViewport?.width ?? innerWidth, vh = window.visualViewport?.height ?? innerHeight;
  for (const r of el.getClientRects()) if (r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh) return true;
  return false;
}
const REF_LINE = /^(\s*)-\s.*\[ref=(e\d+|f\d+e\d+)\](:.*)?$/;
export function aria(args: AriaArgs = {}): string {
  const i = injected();
  const raw: string = i.ariaSnapshot(document.body, { mode: 'ai' });
  const snap = lastSnapshot();
  refIndexFor = new WeakMap(); // a new snapshot: refs re-issued
  const info = snap?.info;
  if (!info) return raw;
  const out: string[] = [];
  let dropBelow: number | null = null; // indent depth of a dropped (offscreen) node: its deeper children go too
  for (const line of raw.split('\n')) {
    const indent = line.length - line.trimStart().length;
    if (dropBelow !== null) { if (indent > dropBelow) continue; dropBelow = null; }
    const m = REF_LINE.exec(line);
    if (!m) { out.push(line); continue; }
    const entry = info.get(m[2]);
    const el = entry?.element;
    if (args.viewport && el && !intersectsViewport(el)) { dropBelow = indent; continue; }
    if (el && m[3] && isCredentialField(el)) { out.push(line.slice(0, line.length - m[3].length) + ': <redacted>'); continue; }
    out.push(line);
  }
  // the plugin always ends its state with the focused element; ours names the focused ref so the next action can target it
  const active = document.activeElement;
  const focusRef = active && active !== document.body ? ariaRefOf(active) : null;
  return out.join('\n') + (focusRef ? `\nFocused: [ref=${focusRef}]` : '');
}

const describe = (el: Element, i: number): FindEntry => {
  const attrs: Record<string, string> = {};
  for (const a of ['id', 'name', 'type', 'placeholder', 'aria-label', 'title', 'href', 'data-testid', 'value']) {
    const v = el.getAttribute(a); if (v) attrs[a] = a === 'value' && isCredentialField(el) ? '<redacted>' : v.slice(0, 200);
  }
  return { nth: i, ref: ariaRefOf(el), selector: replaySelector(el), tag: el.tagName.toLowerCase(), role: roleOf(el), name: nameOf(el).slice(0, 120), text: text(el).slice(0, 120), attrs, visible: is(el, 'visible'), enabled: stateOf(el, 'enabled').received.startsWith('error:') ? null : is(el, 'enabled'), editable: stateOf(el, 'editable').received.startsWith('error:') ? null : is(el, 'editable'), box: box(el) };
};

/** Same engine, same selector and fallback as act; every entry is replayable via `selector` and `ref`. */
export function find(args: FindArgs): FindResult {
  let usedSelector = args.selector;
  let matches = query(args.selector);
  if (!matches.length && args.fallback) { usedSelector = args.fallback; matches = query(args.fallback); }
  const visible_n = matches.filter((m) => is(m, 'visible')).length;
  return { matches_n: matches.length, visible_n, selector: usedSelector, entries: matches.slice(0, Math.max(1, Math.min(args.limit, 100))).map(describe) };
}

/** The element under a viewport point and up to three ancestors: turns visual evidence into locators. */
export function elementAt(args: { x: number; y: number }): ElementAtResult {
  const el = document.elementFromPoint(args.x, args.y);
  if (!el) return { matches_n: 0, entries: [] };
  const chain: Element[] = []; let n: Element | null = el;
  while (n && n !== document.body && chain.length < 4) { chain.push(n); n = n.parentElement; }
  return { matches_n: chain.length, entries: chain.map(describe) };
}

// ── screenshot annotation: eN labels on the elements of the last aria snapshot ──
const ANNOTATE_ID = 'opencli-mcp-annotate';
export function annotate(): number {
  unannotate();
  const snap = lastSnapshot(); if (!snap?.info) return 0;
  const layer = document.createElement('div');
  layer.id = ANNOTATE_ID;
  layer.setAttribute('style', 'all:initial;position:fixed;inset:0;z-index:2147483645;pointer-events:none;font:11px/1 -apple-system,Segoe UI,Arial,sans-serif;');
  let count = 0;
  for (const [ref, v] of snap.info) {
    const el = v?.element; if (!el || !is(el, 'visible') || !intersectsViewport(el)) continue;
    const r = el.getBoundingClientRect();
    const tag = document.createElement('span');
    tag.textContent = ref;
    tag.setAttribute('style', `position:absolute;left:${Math.max(0, r.left)}px;top:${Math.max(0, r.top - 12)}px;background:#1d4ed8;color:#fff;padding:1px 3px;border-radius:2px;white-space:nowrap;`);
    const outline = document.createElement('div');
    outline.setAttribute('style', `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:1px solid rgba(29,78,216,.8);`);
    layer.append(outline, tag);
    if (++count >= 300) break;
  }
  document.documentElement.appendChild(layer);
  return count;
}
export function unannotate(): void { document.getElementById(ANNOTATE_ID)?.remove(); }

/** Evaluate an expectation once (the host polls until it holds or times out). */
export function check(args: Expectation): CheckResult {
  const failed: string[] = [];
  const bodyText = (document.body?.innerText ?? document.body?.textContent ?? '').replace(/\s+/g, ' ');
  if (args.text !== undefined && !bodyText.includes(args.text)) failed.push(`text "${args.text}" not on the page`);
  if (args.notText !== undefined && bodyText.includes(args.notText)) failed.push(`text "${args.notText}" still on the page`);
  if (args.url !== undefined && !location.href.includes(args.url)) failed.push(`url ${location.href} does not include "${args.url}"`);
  if (args.title !== undefined && !document.title.includes(args.title)) failed.push(`title "${document.title}" does not include "${args.title}"`);
  const locator = args.selector ?? (args.ref ? `aria-ref=${args.ref}` : undefined);
  if (locator !== undefined) {
    const els = query(locator);
    const wantVisible = args.visible !== false;
    if (!els.length) { if (wantVisible) failed.push(`${locator} matches nothing`); }
    else if (wantVisible && !els.some((e) => is(e, 'visible'))) failed.push(`${locator} matches but none is visible`);
    else if (!wantVisible && els.some((e) => is(e, 'visible'))) failed.push(`${locator} is still visible`);
  }
  return { ok: failed.length === 0, failed, url: location.href, title: document.title };
}

export const api = { check, resolve, pointInfo, focus, readValue, fill, nativeSet, isChecked, select, caretToEnd, isFileInput, useAssociatedFileInput, clearActMark, settle, frameProbe, clearFrameMark, aria, find, elementAt, annotate, unannotate };
export type PageApi = typeof api;

(globalThis as any)[PAGE_GLOBAL] = api;
