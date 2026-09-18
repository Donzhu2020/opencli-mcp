/**
 * The interaction engine, rebuilt on Playwright's injected script (what the ChatGPT plugin also embeds).
 * Runs at the browser's edge (extension isolated world, or the direct-CDP backend's main world) and does,
 * in one command: compile target → locate with Playwright's engines (strict, unique-visible fallback) →
 * check states (visible/enabled/editable) → scroll (three alignments) → wall-clock stable box → hit-test
 * (expectHitTarget) → cursor overlay → real CDP mouse/keyboard → parallel navigation wait → DOM settle.
 */
import type { ActSpec, ActResult, ActTarget } from '../protocol.js';

export const ENGINE_GLOBAL = '__opencliInjected';

/** Evaluate once per world: installs Playwright's InjectedScript as globalThis.__opencliInjected. */
export function installEngineJs(source: string): string {
  return `(() => {
    if (globalThis.${ENGINE_GLOBAL}) return 'present';
    const module = {};
    ${source}
    globalThis.${ENGINE_GLOBAL}Class = module.exports.InjectedScript();
    globalThis.${ENGINE_GLOBAL} = new globalThis.${ENGINE_GLOBAL}Class(globalThis, {
      isUnderTest: false, sdkLanguage: 'javascript', frameSeq: 0, testIdAttributeName: 'data-testid',
      stableRafCount: 1, browserName: 'chromium', shouldPrependErrorPrefix: false, isUtilityWorld: true, customEngines: [],
    });
    return 'installed';
  })()`;
}

export class ActError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string, readonly extra?: Record<string, unknown>) { super(message); }
}

/** Compile an agent target into a Playwright selector (the same engines the plugin uses). */
export function targetToSelector(t: ActTarget): string | null {
  const q = (s: string, exact = false) => `${JSON.stringify(s)}${exact ? 's' : 'i'}`;
  const nth = typeof t.nth === 'number' ? ` >> nth=${t.nth}` : '';
  if (t.ref !== undefined && t.ref !== null) {
    const r = String(t.ref);
    if (/^e\d+$/.test(r) || /^f\d+e\d+$/.test(r)) return `aria-ref=${r}`; // aria snapshot refs
    return `[data-opencli-ref="${r.replace(/"/g, '')}"]`; // DOM snapshot refs
  }
  if (t.css) return `${t.css}${nth}`;
  if (t.role) return `internal:role=${t.role}${t.name ? `[name=${q(t.name)}]` : ''}${nth}`;
  if (t.testid) return `internal:testid=[data-testid=${q(t.testid, true)}]${nth}`;
  if (t.label) return `internal:label=${q(t.label)}${nth}`;
  if (t.name) return `internal:role=button[name=${q(t.name)}]${nth}`;
  if (t.text) return `internal:text=${q(t.text)}${nth}`;
  return null;
}
/** Secondary selector tried when the primary finds nothing (e.g. label → placeholder). */
export function fallbackSelector(t: ActTarget): string | null {
  const nth = typeof t.nth === 'number' ? ` >> nth=${t.nth}` : '';
  if (t.label) return `internal:attr=[placeholder=${JSON.stringify(t.label)}i]${nth}`;
  if (t.name && !t.role) return `internal:text=${JSON.stringify(t.name)}i${nth}`;
  return null;
}

const WRITE_KINDS = new Set(['click', 'dblclick', 'fill', 'type', 'press', 'check', 'uncheck', 'select', 'upload', 'drag']);
const ALIGNMENTS = [{ block: 'center', inline: 'center' }, { block: 'end', inline: 'end' }, { block: 'start', inline: 'start' }];

/** Page-side: locate + states + scroll + stable box + hit test. Returns {ok,…} or {error:{code,…}, retry?}. */
export function resolveJs(selector: string, fallback: string | null, spec: ActSpec, alignment: { block: string; inline: string }): string {
  const strict = WRITE_KINDS.has(spec.kind);
  const states = spec.kind === 'hover' || spec.kind === 'focus' || spec.kind === 'scroll' ? ['visible'] : spec.kind === 'fill' || spec.kind === 'type' ? ['visible', 'enabled', 'editable'] : ['visible', 'enabled'];
  const frame = spec.target.frame;
  return `(async () => {
    let injected = globalThis.${ENGINE_GLOBAL};
    let root = document; let offset = { x: 0, y: 0 };
    const frameSpec = ${JSON.stringify(frame ?? null)};
    if (frameSpec !== null) {
      // enter a same-origin iframe the way the plugin's enter-frame does: locate the frame element, then run a fresh engine instance in its window
      const frames = typeof frameSpec === 'number' ? [...document.querySelectorAll('iframe,frame')] : injected.querySelectorAll(injected.parseSelector(frameSpec), document);
      const fe = typeof frameSpec === 'number' ? frames[frameSpec] : frames[0];
      if (!fe) return { error: { code: 'frame_not_found', message: 'no iframe matches ' + String(frameSpec) } };
      let fw = null; try { fw = fe.contentWindow; if (fw) fw.document; } catch { fw = null; }
      if (!fw || !fw.document) return { error: { code: 'frame_cross_origin', message: 'the iframe is cross-origin and this backend cannot attach to its process', hint: 'The Chrome extension backend routes cross-origin frames to their own debugger target; the direct CDP backend does not.' } };
      try { fe.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch {}
      const fr = fe.getBoundingClientRect(); offset = { x: fr.left + fe.clientLeft, y: fr.top + fe.clientTop };
      if (!fw.${ENGINE_GLOBAL}) fw.${ENGINE_GLOBAL} = new globalThis.${ENGINE_GLOBAL}Class(fw, { isUnderTest: false, sdkLanguage: 'javascript', frameSeq: 0, testIdAttributeName: 'data-testid', stableRafCount: 1, browserName: 'chromium', shouldPrependErrorPrefix: false, isUtilityWorld: true, customEngines: [] });
      injected = fw.${ENGINE_GLOBAL}; root = fw.document;
    }
    const strict = ${strict}; const states = ${JSON.stringify(states)}; const align = ${JSON.stringify(alignment)};
    const desc = (el) => { const r = el.getBoundingClientRect(); return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80), ref: el.getAttribute('data-opencli-ref'), visible: injected.elementState(el, 'visible').matches === true, box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }; };
    const locate = (sel) => { const parsed = injected.parseSelector(sel); return { parsed, matches: injected.querySelectorAll(parsed, root) }; };
    let sel = ${JSON.stringify(selector)}; let { parsed, matches } = locate(sel);
    if (!matches.length && ${JSON.stringify(fallback)}) { sel = ${JSON.stringify(fallback)}; ({ parsed, matches } = locate(sel)); }
    if (!matches.length) return { error: { code: 'not_found', message: 'no element matches ' + sel, hint: 'Observe the page and use a ref, or loosen the locator.' }, retry: true };
    let el;
    if (matches.length === 1) el = matches[0];
    else {
      const visible = matches.filter((m) => injected.elementState(m, 'visible').matches === true);
      if (visible.length === 1) el = visible[0];
      else if (!strict) el = visible[0] || matches[0];
      else return { error: { code: 'selector_ambiguous', message: matches.length + ' elements match ' + sel + ' (' + visible.length + ' visible)', hint: 'Add nth, or use a ref from candidates.', candidates: matches.slice(0, 10).map(desc) } };
    }
    const safeState = (node, st) => { try { return injected.elementState(node, st); } catch (e) { return { matches: false, received: 'error:' + ((e && e.message) || String(e)) }; } };
    for (const st of states) { const r = safeState(el, st); if (r.received === 'error:notconnected') return { error: { code: 'stale_ref', message: 'element detached during resolution' }, retry: true }; if (!r.matches) return { error: { code: st === 'visible' ? 'not_visible' : st === 'enabled' ? 'not_enabled' : 'not_editable', message: 'element is not ' + st + (typeof r.received === 'string' && r.received.startsWith('error:') ? ' (' + r.received.slice(6) + ')' : ''), candidates: [desc(el)] }, retry: true }; }
    try { el.scrollIntoView({ block: align.block, inline: align.inline, behavior: 'instant' }); } catch {}
    // stable bounding box by wall clock (requestAnimationFrame is paused in background tabs)
    let prev = null, stable = 0; const t0 = performance.now();
    while (true) { const r = el.getBoundingClientRect(); const cur = [r.left, r.top, r.width, r.height].map(Math.round).join(','); stable = prev === cur ? stable + 1 : 0; prev = cur; if (stable >= 1 || performance.now() - t0 > 700) break; await new Promise((res) => setTimeout(res, 40)); }
    for (const st of states) { const r = safeState(el, st); if (!r.matches) return { error: { code: 'not_' + st, message: 'element is not ' + st + ' after scrolling' }, retry: true }; }
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return { error: { code: 'not_visible', message: 'element has no clickable box' }, retry: true };
    const lx = Math.max(0, box.left + box.width / 2), ly = Math.max(0, box.top + box.height / 2);
    const x = lx + offset.x, y = ly + offset.y;
    if (x > innerWidth || y > innerHeight) return { error: { code: 'not_visible', message: 'element is outside the viewport' }, retry: true };
    const tag = el.tagName.toLowerCase();
    // Playwright's elementState throws for states that do not apply to the element (e.g. 'checked' on a text input); treat that as "not in this state"
    const state = (name) => { try { return injected.elementState(el, name).matches; } catch { return null; } };
    const checkable = tag === 'input' && (el.type === 'checkbox' || el.type === 'radio') || ['checkbox', 'radio', 'switch'].includes(el.getAttribute('role') || '');
    const hit = injected.expectHitTarget({ x: lx, y: ly }, el);
    document.querySelectorAll('[data-opencli-act]').forEach((n) => n.removeAttribute('data-opencli-act'));
    root.querySelectorAll('[data-opencli-act]').forEach((n) => n.removeAttribute('data-opencli-act'));
    el.setAttribute('data-opencli-act', '1');
    let selectorForReplay = null; try { selectorForReplay = injected.generateSelector(el, { testIdAttributeName: 'data-testid' }).selector; } catch {}
    return { ok: true, x, y, matches_n: matches.length, tag, hit: hit === 'done' ? 'target' : 'other', blocker: hit === 'done' ? null : (hit && hit.hitTargetDescription) || 'another element', editable: state('editable') === true, checkable: checkable, checked: checkable ? state('checked') === true : false, isSelect: tag === 'select', ref: el.getAttribute('data-opencli-ref'), selector: selectorForReplay, usedSelector: sel };
  })()`;
}

/** The element marked by the resolver — in the document or in any same-origin iframe entered. */
const ACT_EL = `(document.querySelector('[data-opencli-act]') || [...document.querySelectorAll('iframe,frame')].map((f) => { try { return f.contentDocument && f.contentDocument.querySelector('[data-opencli-act]'); } catch { return null; } }).find(Boolean))`;
function settleJs(maxMs: number, quietMs: number): string {
  return `new Promise((res) => { const t0 = performance.now(); let last = performance.now(); const obs = new MutationObserver(() => { last = performance.now(); }); obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); const tick = () => { const now = performance.now(); if (now - last >= ${quietMs} || now - t0 >= ${maxMs}) { obs.disconnect(); res(Math.round(now - t0)); } else setTimeout(tick, 50); }; setTimeout(tick, 50); })`;
}

interface KeyDef { key: string; code: string; keyCode: number; text?: string }
const KEYS: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }, return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 }, escape: { key: 'Escape', code: 'Escape', keyCode: 27 }, esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 }, delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' }, arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }, arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }, arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 }, up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }, down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  home: { key: 'Home', code: 'Home', keyCode: 36 }, end: { key: 'End', code: 'End', keyCode: 35 }, pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 }, pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
const MODS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
function parseKey(spec: string): { def: KeyDef; modifiers: number } {
  const parts = spec.split('+').map((p) => p.trim()).filter(Boolean);
  let modifiers = 0; const keyName = parts[parts.length - 1] ?? spec;
  for (const p of parts.slice(0, -1)) modifiers |= MODS[p.toLowerCase()] ?? 0;
  const lower = keyName.toLowerCase();
  if (KEYS[lower]) return { def: KEYS[lower], modifiers };
  if (keyName.length === 1) { const upper = keyName.toUpperCase(); const code = /[a-z]/i.test(keyName) ? `Key${upper}` : /[0-9]/.test(keyName) ? `Digit${keyName}` : ''; return { def: { key: keyName, code, keyCode: upper.charCodeAt(0), text: modifiers & 6 ? undefined : keyName }, modifiers }; }
  return { def: { key: keyName, code: keyName, keyCode: 0 }, modifiers };
}

/** What a runtime edge provides: engine-world evaluation, raw CDP on the attached target, cursor, navigation wait. */
export interface ActIO {
  evaluate(js: string, timeoutMs?: number): Promise<unknown>;
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  cursor?(x: number, y: number): Promise<unknown>;
  /** Resolve after a navigation the action triggered has finished (or when none started within classifyMs). */
  waitForNavigation?(classifyMs: number, timeoutMs: number): Promise<{ navigated: boolean; url?: string }>;
  /** When `evaluate` runs inside an out-of-process iframe, the iframe's position in the top viewport: input events are dispatched on the tab, so resolved points are shifted by this. */
  pointOffset?: { x: number; y: number };
}

/** Marker the edge sets on an <iframe> element it is about to route into (cross-origin frames need their own debugger target). */
export const FRAME_MARK = 'data-opencli-frame';

/**
 * Main-world probe for `target.frame`: locate the iframe element and report whether the resolver can enter it
 * in-process (same-origin) or the edge must route to the frame's own target. Marks the element with FRAME_MARK
 * so the edge can map it to a CDP frameId (DOM.describeNode) without knowing its selector.
 */
export function frameProbeJs(frame: string | number): string {
  return `(() => {
    const injected = globalThis.${ENGINE_GLOBAL};
    const spec = ${JSON.stringify(frame)};
    document.querySelectorAll('[${FRAME_MARK}]').forEach((n) => n.removeAttribute('${FRAME_MARK}'));
    const list = typeof spec === 'number' ? [...document.querySelectorAll('iframe,frame')] : injected.querySelectorAll(injected.parseSelector(spec), document);
    const fe = typeof spec === 'number' ? list[spec] : list[0];
    if (!fe) return { found: false };
    let sameOrigin = false; try { sameOrigin = Boolean(fe.contentWindow && fe.contentWindow.document); } catch { sameOrigin = false; }
    if (sameOrigin) return { found: true, sameOrigin: true };
    try { fe.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch {}
    fe.setAttribute('${FRAME_MARK}', '1');
    const r = fe.getBoundingClientRect();
    return { found: true, sameOrigin: false, x: r.left + fe.clientLeft, y: r.top + fe.clientTop, src: fe.src || '' };
  })()`;
}

async function mouse(io: ActIO, type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, y: number, clickCount = 0, button: 'left' | 'none' = 'left'): Promise<void> {
  await io.cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : button, clickCount, buttons: type === 'mousePressed' ? 1 : 0 });
}
async function key(io: ActIO, spec: string): Promise<void> {
  const { def, modifiers } = parseKey(spec);
  await io.cdp('Input.dispatchKeyEvent', { type: def.text ? 'keyDown' : 'rawKeyDown', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers, ...(def.text && { text: def.text, unmodifiedText: def.text }) });
  await io.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers });
}

type Resolved = { ok: true; x: number; y: number; matches_n: number; tag: string; hit: 'target' | 'other'; blocker: string | null; editable: boolean; checkable: boolean; checked: boolean; isSelect: boolean; ref: string | null; selector: string | null; usedSelector: string };
type ResolveFail = { error: { code: string; message: string; hint?: string; candidates?: unknown[] }; retry?: boolean };

async function resolve(io: ActIO, spec: ActSpec, target: ActTarget, timeoutMs: number, started: number): Promise<Resolved> {
  if (typeof target.x === 'number' && typeof target.y === 'number') {
    const r = await io.evaluate(`(() => { const el = document.elementFromPoint(${target.x}, ${target.y}); if (!el) return null; document.querySelectorAll('[data-opencli-act]').forEach((n) => n.removeAttribute('data-opencli-act')); el.setAttribute('data-opencli-act', '1'); return { tag: el.tagName.toLowerCase(), editable: !!(el.isContentEditable || (['INPUT','TEXTAREA'].includes(el.tagName) && !el.readOnly)), isSelect: el.tagName === 'SELECT' }; })()`) as { tag: string; editable: boolean; isSelect: boolean } | null;
    if (!r) throw new ActError('not_found', `nothing at point ${target.x},${target.y}`);
    return { ok: true, x: target.x, y: target.y, matches_n: 1, tag: r.tag, hit: 'target', blocker: null, editable: r.editable, checkable: false, checked: false, isSelect: r.isSelect, ref: null, selector: null, usedSelector: `point:${target.x},${target.y}` };
  }
  const selector = targetToSelector(target);
  if (!selector) throw new ActError('invalid_target', 'target needs ref, css, x/y, or a semantic locator (role/name/label/text/testid)');
  const fallback = fallbackSelector(target);
  let last: ResolveFail | null = null;
  for (;;) {
    for (const align of spec.force ? [ALIGNMENTS[0]] : ALIGNMENTS) {
      const res = await io.evaluate(resolveJs(selector, fallback, spec, align), timeoutMs + 2000) as Resolved | ResolveFail;
      if ('ok' in res && res.ok) {
        if (res.hit === 'other' && !spec.force) { last = { error: { code: 'intercepted', message: `${res.blocker ?? 'another element'} intercepts the ${spec.kind} point`, hint: 'Dismiss the overlay/modal first, or pass force:true.' }, retry: true }; continue; }
        return res;
      }
      last = res as ResolveFail;
      if (!last.retry) throw new ActError(last.error.code, last.error.message, last.error.hint, last.error.candidates ? { candidates: last.error.candidates } : undefined);
      break; // other alignments only matter after a hit-test miss
    }
    if (Date.now() - started >= timeoutMs) break;
    await new Promise((s) => setTimeout(s, 100));
  }
  const e = last?.error ?? { code: 'timeout', message: 'target did not become actionable' };
  throw new ActError(e.code, `${e.message} (waited ${Date.now() - started}ms)`, e.hint, e.candidates ? { candidates: e.candidates } : undefined);
}

export async function performAct(io: ActIO, spec: ActSpec): Promise<ActResult> {
  const timeoutMs = spec.timeoutMs ?? 3000;
  const started = Date.now();
  const r = await resolve(io, spec, spec.target, timeoutMs, started);
  if (io.pointOffset) { r.x += io.pointOffset.x; r.y += io.pointOffset.y; }
  if (spec.cursor && io.cursor) await io.cursor(r.x, r.y).catch(() => {});
  const base: ActResult = { ok: true, kind: spec.kind, ref: r.ref, matches_n: r.matches_n, visible_n: r.matches_n, match_level: 'exact', point: { x: Math.round(r.x), y: Math.round(r.y) }, method: 'cdp', hit: r.hit, tag: r.tag, waitedMs: Date.now() - started, selector: r.selector ?? undefined };
  const engineFor = `((el) => (el && el.ownerDocument && el.ownerDocument.defaultView && el.ownerDocument.defaultView.${ENGINE_GLOBAL}) || globalThis.${ENGINE_GLOBAL})`;
  const focus = () => io.evaluate(`(() => { const el = ${ACT_EL}; const injected = ${engineFor}(el); if (!el) return 'error:notconnected'; const t = injected.retarget(el, 'follow-label') || el; const r = injected.focusNode(t, false); return r; })()`);
  const readValue = () => io.evaluate(`(() => { const el = ${ACT_EL}; const injected = ${engineFor}(el); if (!el) return null; const t = injected.retarget(el, 'follow-label') || el; return t.isContentEditable ? t.textContent : t.value; })()`) as Promise<string | null>;
  const navWait = spec.kind === 'click' || spec.kind === 'dblclick' || spec.kind === 'press' ? io.waitForNavigation?.(300, timeoutMs + 12_000) : undefined;
  switch (spec.kind) {
    case 'hover': await mouse(io, 'mouseMoved', r.x, r.y); break;
    case 'focus': { const f = await focus(); if (f !== 'done') throw new ActError('action_failed', `focus: ${String(f)}`); break; }
    case 'click': case 'dblclick': {
      const count = spec.kind === 'dblclick' ? 2 : 1;
      await mouse(io, 'mouseMoved', r.x, r.y);
      for (let i = 1; i <= count; i++) { await mouse(io, 'mousePressed', r.x, r.y, i); await mouse(io, 'mouseReleased', r.x, r.y, i); }
      break;
    }
    case 'check': case 'uncheck': {
      const want = spec.kind === 'check';
      if (!r.checkable) throw new ActError('not_checkable', 'target is not a checkbox/radio/switch');
      if (r.checked !== want) { await mouse(io, 'mouseMoved', r.x, r.y); await mouse(io, 'mousePressed', r.x, r.y, 1); await mouse(io, 'mouseReleased', r.x, r.y, 1); }
      const after = await io.evaluate(`(() => { const el = ${ACT_EL}; const injected = ${engineFor}(el); if (!el) return null; try { return injected.elementState(el, 'checked').matches === true; } catch { return null; } })()`) as boolean | null;
      Object.assign(base, { checked: after, changed: after !== r.checked });
      if (after !== want) throw new ActError('action_failed', `expected checked=${want} but got ${after}`);
      break;
    }
    case 'fill': {
      if (!r.editable) throw new ActError('not_editable', 'target is not an editable field', 'Click the control that opens the editor, or target the input itself.');
      const value = spec.value ?? '';
      // Playwright's fill: sets the value for date/color/range inputs ('done'), or focuses + selects text and asks for input ('needsinput')
      const outcome = await io.evaluate(`(() => { const el = ${ACT_EL}; const injected = ${engineFor}(el); if (!el) return 'error:notconnected'; try { return injected.fill(el, ${JSON.stringify(value)}); } catch (e) { return 'error:' + (e && e.message || e); } })()`) as string;
      if (outcome === 'needsinput') {
        if (value === '') await key(io, 'Backspace'); else await io.cdp('Input.insertText', { text: value });
      } else if (outcome !== 'done') throw new ActError('not_editable', outcome.replace(/^error:/, ''));
      const actual = await readValue();
      let verified = actual === value;
      if (!verified) {
        // React/Vue controlled inputs that swallow insertText: native setter + input event, then re-verify
        await io.evaluate(`(() => { const el = ${ACT_EL}; const injected = ${engineFor}(el); if (!el) return; const t = injected.retarget(el, 'follow-label') || el; const v = ${JSON.stringify(value)}; if (t.isContentEditable) t.textContent = v; else { const proto = t.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set; if (set) set.call(t, v); else t.value = v; } t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        verified = (await readValue()) === value;
        Object.assign(base, { method: 'dom' });
      }
      Object.assign(base, { filled: true, verified, actual: actual ?? undefined });
      break;
    }
    case 'type': {
      if (!r.editable) throw new ActError('not_editable', 'target is not an editable field');
      const f = await focus(); if (f !== 'done') throw new ActError('action_failed', `focus: ${String(f)}`);
      await io.evaluate(`(() => { const el = document.activeElement; if (el && !el.isContentEditable && typeof el.setSelectionRange === 'function') { try { const n = el.value.length; el.setSelectionRange(n, n); } catch {} } })()`);
      if (spec.value) await io.cdp('Input.insertText', { text: spec.value });
      const actual = await readValue();
      Object.assign(base, { filled: true, verified: Boolean(actual && actual.endsWith(spec.value ?? '')), actual: actual ?? undefined });
      break;
    }
    case 'press': { const f = await focus(); if (f !== 'done' && f !== 'error:notconnected') { /* non-focusable targets still receive page-level keys */ } await key(io, spec.value ?? 'Enter'); Object.assign(base, { key: spec.value ?? 'Enter' }); break; }
    case 'select': {
      if (!r.isSelect) throw new ActError('not_a_select', 'target is not a <select>; click it and choose the option like a user');
      const res = await io.evaluate(`(() => { const el = ${ACT_EL}; const injected = ${engineFor}(el); if (!el) return { error: 'gone' }; const want = ${JSON.stringify(spec.value ?? '')}; let r = injected.selectOptions(el, [{ valueOrLabel: want }]); if (r === 'error:optionsnotfound' && /^\\d+$/.test(want)) r = injected.selectOptions(el, [{ index: Number(want) }]); if (typeof r === 'string' && r.startsWith('error:')) return { error: r.slice(6), available: [...el.options].slice(0, 50).map((o) => o.label || o.text) }; return { selected: Array.isArray(r) ? r : [want] }; })()`) as { error?: string; available?: string[]; selected?: string[] };
      if (res.error) throw new ActError(res.error === 'optionsnotfound' ? 'option_not_found' : res.error, res.error === 'optionsnotfound' ? `no option matches "${spec.value}"` : res.error, undefined, res.available ? { available: res.available } : undefined);
      Object.assign(base, { method: 'dom', selected: res.selected });
      break;
    }
    case 'scroll': {
      const dir = spec.direction ?? 'down'; const amount = spec.amount ?? 600;
      const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0; const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
      await io.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.x, y: r.y, deltaX: dx, deltaY: dy });
      Object.assign(base, { direction: dir, amount });
      break;
    }
    case 'upload': {
      const files = spec.files ?? [];
      if (!files.length) throw new ActError('missing_files', 'upload needs files');
      const doc = await io.cdp('DOM.getDocument', { depth: 0 }) as { root: { nodeId: number } };
      const isInput = await io.evaluate(`(() => { const el = ${ACT_EL}; return !!el && el.tagName === 'INPUT' && el.type === 'file'; })()`) as boolean;
      if (!isInput) {
        const ok = await io.evaluate(`(() => { const el = ${ACT_EL}; const inp = el.querySelector('input[type=file]') || (el.control && el.control.type === 'file' ? el.control : null) || (el.closest('form,body') || document.body).querySelector('input[type=file]'); if (!inp) return false; document.querySelectorAll('[data-opencli-act]').forEach((n) => n.removeAttribute('data-opencli-act')); inp.setAttribute('data-opencli-act', '1'); return true; })()`) as boolean;
        if (!ok) throw new ActError('not_a_file_input', 'no file input associated with the target', 'Target the <input type=file> directly.');
      }
      const q = await io.cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '[data-opencli-act]' }) as { nodeId: number };
      await io.cdp('DOM.setFileInputFiles', { files, nodeId: q.nodeId });
      Object.assign(base, { files: files.length });
      break;
    }
    case 'drag': {
      if (!spec.to) throw new ActError('missing_target', 'drag needs `to`');
      const dest = await resolve(io, { ...spec, kind: 'hover' }, spec.to, timeoutMs, Date.now());
      await mouse(io, 'mouseMoved', r.x, r.y); await mouse(io, 'mousePressed', r.x, r.y, 1);
      const steps = 8; for (let i = 1; i <= steps; i++) await mouse(io, 'mouseMoved', r.x + (dest.x - r.x) * i / steps, r.y + (dest.y - r.y) * i / steps);
      await mouse(io, 'mouseReleased', dest.x, dest.y, 1);
      Object.assign(base, { to: { x: Math.round(dest.x), y: Math.round(dest.y) } });
      break;
    }
  }
  if (navWait) { const nav: { navigated: boolean; url?: string } = await navWait.catch(() => ({ navigated: false })); if (nav.navigated) Object.assign(base, { navigated: true, url: nav.url }); }
  const settleMs = spec.settleMs ?? 600;
  const actionDone = Date.now();
  if (settleMs > 0 && !(base as { navigated?: boolean }).navigated) { try { await io.evaluate(settleJs(settleMs, Math.min(200, settleMs)), settleMs + 1500); } catch { /* navigation in flight */ } }
  const settled = Date.now();
  Object.assign(base, { elapsedMs: settled - started, timings: { resolveMs: base.waitedMs, actionMs: actionDone - started - base.waitedMs, settleMs: settled - actionDone } });
  try { await io.evaluate(`(() => { const el = ${ACT_EL}; if (el) el.removeAttribute('data-opencli-act'); })()`, 1000); } catch { /* page changed */ }
  return base;
}

/** Aria snapshot (Playwright's agent-facing accessibility text with [ref=eN]); refs resolve via the `aria-ref=eN` engine. */
export function ariaSnapshotJs(): string {
  // Credential fields (password/otp/email/username/phone by type, autocomplete, id, name, placeholder, label, title — the
  // ChatGPT plugin's rule) never expose their value to the model: the rendered line keeps the field, drops the text.
  // String.raw: this is page code, so regex escapes and '\n' must reach the page verbatim.
  return String.raw`(() => {
    const injected = globalThis.${ENGINE_GLOBAL};
    const text = injected.ariaSnapshot(document.body, { mode: 'ai' });
    const info = injected._lastAriaSnapshotForQuery && injected._lastAriaSnapshotForQuery.info;
    if (!info) return text;
    const cred = /user[-_ ]?name|e[-_ ]?mail|one[-_ ]?time[-_ ]?code|password|passcode|passwd|\botp\b|\b(?:2fa|mfa)\b|phone|mobile|\btel\b|cvc|cvv|card[-_ ]?number|ssn/i;
    const isCred = (el) => { if (!el || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false; if (el.type === 'password') return true; const hay = ['type', 'autocomplete', 'id', 'name', 'placeholder', 'aria-label', 'title'].map((a) => el.getAttribute(a) || '').join(' '); return cred.test(hay); };
    return text.split('\n').map((line) => {
      const m = /\[ref=(e\d+)\](:.*)?$/.exec(line);
      if (!m || !m[2]) return line;
      const entry = info.get(m[1]);
      return entry && isCred(entry.element) ? line.slice(0, line.length - m[2].length) + ': <redacted>' : line;
    }).join('\n');
  })()`;
}
