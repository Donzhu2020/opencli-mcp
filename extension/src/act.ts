/**
 * Atomic interaction inside the browser runtime.
 * One command does what a CLI needed four round-trips for: locate (ref / css / semantic) →
 * wait until visible+enabled with a stable box → scroll into view → hit-test the click point →
 * move the cursor overlay → dispatch real mouse/keyboard input via chrome.debugger → wait for the
 * DOM to settle. Errors are branchable codes, never prose.
 */
import type { ActSpec, ActResult } from '../../src/protocol.js';
import * as executor from './cdp';

export class ActError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string, readonly extra?: Record<string, unknown>) { super(message); }
}

const WRITE_KINDS = new Set(['click', 'dblclick', 'fill', 'type', 'press', 'check', 'uncheck', 'select']);

/** Page-side resolver: returns {ok,...} or {error:{code,...}, retry?:true}. Runs in the page's main world. */
function resolverJs(spec: ActSpec): string {
  const target = JSON.stringify(spec.target);
  const strict = WRITE_KINDS.has(spec.kind);
  const needEnabled = spec.kind !== 'hover' && spec.kind !== 'focus';
  return `(() => {
    const target = ${target}; const strict = ${strict}; const needEnabled = ${needEnabled};
    const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const matchText = (hay, needle) => { const h = norm(hay), n = norm(needle); return n.length > 0 && (h === n || h.includes(n)); };
    const vis = (el) => { if (!el || !el.getBoundingClientRect) return false; const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) !== 0; };
    const enabled = (el) => !(el.disabled || el.getAttribute('aria-disabled') === 'true');
    const implicitRole = (el) => { const t = el.tagName.toLowerCase(); const ty = (el.getAttribute('type') || '').toLowerCase();
      if (t === 'a' && el.hasAttribute('href')) return 'link'; if (t === 'button') return 'button'; if (t === 'input') { if (['button','submit','reset','image'].includes(ty)) return 'button'; if (ty === 'checkbox') return 'checkbox'; if (ty === 'radio') return 'radio'; if (ty === 'range') return 'slider'; if (ty === 'search') return 'searchbox'; return 'textbox'; }
      if (t === 'textarea') return 'textbox'; if (t === 'select') return 'combobox'; if (/^h[1-6]$/.test(t)) return 'heading'; if (t === 'img') return 'img'; if (t === 'li') return 'listitem'; if (t === 'option') return 'option'; if (t === 'nav') return 'navigation'; if (t === 'table') return 'table'; if (t === 'summary') return 'button'; if (el.isContentEditable) return 'textbox'; return ''; };
    const roleOf = (el) => el.getAttribute('role') || implicitRole(el);
    const labelOf = (el) => { let s = ''; if (el.labels) for (const l of el.labels) s += ' ' + l.textContent; const id = el.getAttribute('id'); if (id) { const l = document.querySelector('label[for="' + CSS.escape(id) + '"]'); if (l) s += ' ' + l.textContent; } const wrap = el.closest('label'); if (wrap) s += ' ' + wrap.textContent; return s; };
    const accName = (el) => { const al = el.getAttribute('aria-label'); if (al) return al; const lb = el.getAttribute('aria-labelledby'); if (lb) return lb.split(/\\s+/).map((i) => document.getElementById(i)?.textContent || '').join(' '); const t = el.tagName.toLowerCase(); if (t === 'input') { const ty = (el.getAttribute('type') || '').toLowerCase(); if (['button','submit','reset'].includes(ty)) return el.value; } const lab = labelOf(el); if (lab.trim()) return lab; return el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || (el.innerText || el.textContent || '').slice(0, 300); };
    const desc = (el) => el ? { tag: el.tagName.toLowerCase(), role: roleOf(el), text: norm(el.innerText || el.textContent).slice(0, 80), ref: el.getAttribute('data-opencli-ref'), id: el.id || undefined, cls: (el.className && typeof el.className === 'string') ? el.className.slice(0, 60) : undefined } : null;
    let candidates = [];
    if (target.ref !== undefined && target.ref !== null) { const el = document.querySelector('[data-opencli-ref="' + String(target.ref) + '"]'); if (!el) return { error: { code: 'stale_ref', message: 'ref ' + target.ref + ' is no longer in the DOM', hint: 'Observe the page again and use a fresh ref.' } }; candidates = [el]; }
    else if (target.css) { try { candidates = [...document.querySelectorAll(target.css)]; } catch (e) { return { error: { code: 'invalid_selector', message: String(e && e.message || e) } }; } if (candidates.length === 0) return { error: { code: 'selector_not_found', message: 'no element matches ' + target.css }, retry: true }; }
    else if (typeof target.x === 'number') { const el = document.elementFromPoint(target.x, target.y); if (!el) return { error: { code: 'not_found', message: 'nothing at point' } }; candidates = [el]; }
    else {
      const wants = ['role','name','label','text','testid'].filter((k) => target[k]);
      if (wants.length === 0) return { error: { code: 'invalid_target', message: 'target needs ref, css, x/y, or a semantic locator' } };
      const all = document.querySelectorAll('body *');
      for (const el of all) {
        if (el.closest('#opencli-mcp-overlay-root')) continue;
        if (target.testid && el.getAttribute('data-testid') !== target.testid) continue;
        if (target.role && roleOf(el) !== target.role) continue;
        if (target.name && !matchText(accName(el), target.name)) continue;
        if (target.label && !(matchText(labelOf(el), target.label) || matchText(accName(el), target.label) || matchText(el.getAttribute('placeholder'), target.label))) continue;
        if (target.text && !matchText(el.innerText || el.textContent, target.text)) continue;
        if (!target.role && !target.testid && !target.label && target.text && !target.name) { const t = el.tagName.toLowerCase(); if (['html','body','script','style'].includes(t)) continue; }
        candidates.push(el);
      }
      // innermost match wins: drop elements that contain another candidate
      candidates = candidates.filter((el) => !candidates.some((o) => o !== el && el.contains(o)));
      if (candidates.length === 0) return { error: { code: 'not_found', message: 'no element matches ' + JSON.stringify(target), hint: 'Observe and pick a ref, or loosen the locator.' }, retry: true };
    }
    const visible = candidates.filter(vis);
    let el = null;
    if (typeof target.nth === 'number') { el = candidates[target.nth]; if (!el) return { error: { code: 'selector_nth_out_of_range', message: 'nth=' + target.nth + ' but ' + candidates.length + ' matches', candidates: candidates.slice(0, 10).map(desc) } }; }
    else if (visible.length === 1) el = visible[0];
    else if (candidates.length === 1) el = candidates[0];
    else if (visible.length > 1) { if (strict) return { error: { code: 'selector_ambiguous', message: visible.length + ' visible matches', hint: 'Add nth or use a ref from candidates.', candidates: visible.slice(0, 10).map(desc) } }; el = visible[0]; }
    else return { error: { code: 'not_visible', message: candidates.length + ' matches but none visible', hint: 'Scroll or open the containing control.', candidates: candidates.slice(0, 10).map(desc) }, retry: true };
    if (!vis(el)) return { error: { code: 'not_visible', message: 'target is not visible' }, retry: true };
    if (needEnabled && !enabled(el)) return { error: { code: 'not_enabled', message: 'target is disabled' }, retry: true };
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch {}
    return new Promise((res) => {
      const t0 = performance.now(); let prev = null; let stable = 0;
      const tick = () => {
        const r = el.getBoundingClientRect(); const cur = [r.left, r.top, r.width, r.height].map(Math.round).join(',');
        stable = prev === cur ? stable + 1 : 0; prev = cur;
        if (stable >= 1 || performance.now() - t0 > 700) {
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return res({ error: { code: 'not_visible', message: 'target is outside the viewport' }, retry: true });
          const hitEl = document.elementFromPoint(cx, cy);
          let hit = 'other'; if (hitEl === el || (hitEl && el.contains(hitEl))) hit = 'target'; else if (hitEl && hitEl.contains(el)) hit = 'ancestor';
          document.querySelectorAll('[data-opencli-act]').forEach((n) => n.removeAttribute('data-opencli-act'));
          el.setAttribute('data-opencli-act', '1');
          const ce = el.isContentEditable; const tag = el.tagName.toLowerCase();
          res({ ok: true, x: cx, y: cy, matches_n: candidates.length, visible_n: visible.length, tag, hit, blocker: hit === 'other' ? desc(hitEl) : null, editable: ce || ((tag === 'input' || tag === 'textarea') && !el.readOnly), checkable: tag === 'input' && (el.type === 'checkbox' || el.type === 'radio') || ['checkbox','radio','switch'].includes(el.getAttribute('role') || ''), checked: el.checked ?? (el.getAttribute('aria-checked') === 'true'), isSelect: tag === 'select', ref: el.getAttribute('data-opencli-ref') });
        } else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  })()`;
}

const ACT_EL = `document.querySelector('[data-opencli-act]')`;

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
  let modifiers = 0; let keyName = parts[parts.length - 1] ?? spec;
  for (const p of parts.slice(0, -1)) modifiers |= MODS[p.toLowerCase()] ?? 0;
  const lower = keyName.toLowerCase();
  if (KEYS[lower]) return { def: KEYS[lower], modifiers };
  if (keyName.length === 1) { const upper = keyName.toUpperCase(); const code = /[a-z]/i.test(keyName) ? `Key${upper}` : /[0-9]/.test(keyName) ? `Digit${keyName}` : ''; return { def: { key: keyName, code, keyCode: upper.charCodeAt(0), text: modifiers & 6 ? undefined : keyName }, modifiers }; }
  return { def: { key: keyName, code: keyName, keyCode: 0 }, modifiers };
}

async function mouse(tabId: number, type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, y: number, clickCount = 0, button: 'left' | 'none' = 'left'): Promise<void> {
  await executor.sendDebuggerCommand({ tabId }, 'Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : button, clickCount, buttons: type === 'mousePressed' ? 1 : 0 });
}
async function key(tabId: number, spec: string): Promise<void> {
  const { def, modifiers } = parseKey(spec);
  await executor.sendDebuggerCommand({ tabId }, 'Input.dispatchKeyEvent', { type: def.text ? 'keyDown' : 'rawKeyDown', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers, ...(def.text && { text: def.text, unmodifiedText: def.text }) });
  await executor.sendDebuggerCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers });
}

export async function performAct(tabId: number, spec: ActSpec, opts: { aggressive: boolean; cursor?: (x: number, y: number) => Promise<unknown> }): Promise<ActResult> {
  const timeoutMs = spec.timeoutMs ?? 3000;
  const started = Date.now();
  await executor.ensureAttached(tabId, opts.aggressive);
  type Resolved = { ok: true; x: number; y: number; matches_n: number; visible_n: number; tag: string; hit: 'target' | 'ancestor' | 'other'; blocker: unknown; editable: boolean; checkable: boolean; checked: boolean; isSelect: boolean; ref: string | null };
  let r: Resolved | undefined;
  for (;;) {
    const res = await executor.evaluate(tabId, resolverJs(spec), opts.aggressive, timeoutMs + 2000) as Resolved | { error: { code: string; message: string; hint?: string; candidates?: unknown[] }; retry?: boolean };
    if ('ok' in res && res.ok) {
      if (res.hit === 'other' && !spec.force && Date.now() - started < timeoutMs) { await new Promise((s) => setTimeout(s, 150)); const again = await executor.evaluate(tabId, resolverJs(spec), opts.aggressive, timeoutMs + 2000) as Resolved | { error: unknown }; if ('ok' in again && again.ok && again.hit !== 'other') { r = again; break; } if ('ok' in again && again.ok) { throw new ActError('intercepted', `another element covers the click point: ${JSON.stringify(again.blocker)}`, 'Dismiss the overlay/modal first, or pass force:true to click anyway.', { blocker: again.blocker }); } }
      r = res; break;
    }
    const err = (res as { error: { code: string; message: string; hint?: string; candidates?: unknown[] }; retry?: boolean });
    if (err.retry && Date.now() - started < timeoutMs) { await new Promise((s) => setTimeout(s, 100)); continue; }
    throw new ActError(err.error.code, err.error.message, err.error.hint, err.error.candidates ? { candidates: err.error.candidates } : undefined);
  }
  if (spec.cursor && opts.cursor) await opts.cursor(r.x, r.y).catch(() => {});
  const base: ActResult = { ok: true, kind: spec.kind, ref: r.ref, matches_n: r.matches_n, visible_n: r.visible_n, match_level: 'exact', point: { x: Math.round(r.x), y: Math.round(r.y) }, method: 'cdp', hit: r.hit, tag: r.tag, waitedMs: Date.now() - started };
  const focus = () => executor.evaluate(tabId, `(() => { const el = ${ACT_EL}; if (!el) return false; el.focus({ preventScroll: true }); return document.activeElement === el; })()`, opts.aggressive);
  switch (spec.kind) {
    case 'hover': await mouse(tabId, 'mouseMoved', r.x, r.y); break;
    case 'focus': await focus(); break;
    case 'click': case 'dblclick': {
      const count = spec.kind === 'dblclick' ? 2 : 1;
      await mouse(tabId, 'mouseMoved', r.x, r.y);
      for (let i = 1; i <= count; i++) { await mouse(tabId, 'mousePressed', r.x, r.y, i); await mouse(tabId, 'mouseReleased', r.x, r.y, i); }
      break;
    }
    case 'check': case 'uncheck': {
      const want = spec.kind === 'check';
      if (!r.checkable) throw new ActError('not_checkable', 'target is not a checkbox/radio/switch');
      if (r.checked !== want) { await mouse(tabId, 'mouseMoved', r.x, r.y); await mouse(tabId, 'mousePressed', r.x, r.y, 1); await mouse(tabId, 'mouseReleased', r.x, r.y, 1); }
      const after = await executor.evaluate(tabId, `(() => { const el = ${ACT_EL}; return el ? (el.checked ?? el.getAttribute('aria-checked') === 'true') : null; })()`, opts.aggressive) as boolean | null;
      Object.assign(base, { checked: after, changed: after !== r.checked });
      if (after !== want) throw new ActError('action_failed', `expected checked=${want} but got ${after}`);
      break;
    }
    case 'fill': case 'type': {
      if (!r.editable) throw new ActError('not_editable', 'target is not an editable field', 'Use click on the control that opens the editor, or target the input itself.');
      const value = spec.value ?? '';
      // click to focus like a user would (opens custom editors), then place the caret
      await mouse(tabId, 'mouseMoved', r.x, r.y); await mouse(tabId, 'mousePressed', r.x, r.y, 1); await mouse(tabId, 'mouseReleased', r.x, r.y, 1);
      await executor.evaluate(tabId, `(() => { const el = ${ACT_EL}; if (!el) return; el.focus({ preventScroll: true }); if (${spec.kind === 'fill'}) { if (el.isContentEditable) { const s = getSelection(); s.selectAllChildren(el); } else if (typeof el.select === 'function') el.select(); } else if (!el.isContentEditable && typeof el.setSelectionRange === 'function') { try { const n = el.value.length; el.setSelectionRange(n, n); } catch {} } })()`, opts.aggressive);
      if (spec.kind === 'fill' && value === '') await key(tabId, 'Backspace');
      if (value) await executor.sendDebuggerCommand({ tabId }, 'Input.insertText', { text: value });
      const actual = await executor.evaluate(tabId, `(() => { const el = ${ACT_EL}; return el ? (el.isContentEditable ? el.textContent : el.value) : null; })()`, opts.aggressive) as string | null;
      let verified = spec.kind === 'fill' ? actual === value : Boolean(actual && actual.endsWith(value));
      if (!verified && spec.kind === 'fill') {
        // React/Vue controlled inputs sometimes swallow insertText: fall back to the native setter + input event
        await executor.evaluate(tabId, `(() => { const el = ${ACT_EL}; if (!el) return; const v = ${JSON.stringify(value)}; if (el.isContentEditable) { el.textContent = v; } else { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set; if (set) set.call(el, v); else el.value = v; } el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`, opts.aggressive);
        const again = await executor.evaluate(tabId, `(() => { const el = ${ACT_EL}; return el ? (el.isContentEditable ? el.textContent : el.value) : null; })()`, opts.aggressive) as string | null;
        verified = again === value;
        Object.assign(base, { method: 'dom', filled: true, verified, actual: again ?? undefined });
      } else Object.assign(base, { filled: true, verified, actual: actual ?? undefined });
      break;
    }
    case 'press': { await focus(); await key(tabId, spec.value ?? 'Enter'); Object.assign(base, { key: spec.value ?? 'Enter' }); break; }
    case 'select': {
      const res = await executor.evaluate(tabId, `(() => { const el = ${ACT_EL}; if (!el) return { error: 'gone' }; const want = ${JSON.stringify(spec.value ?? '')}; if (el.tagName.toLowerCase() !== 'select') return { error: 'not_a_select', available: [] }; const opts = [...el.options]; const norm = (s) => String(s || '').trim().toLowerCase(); let o = opts.find((x) => norm(x.label || x.text) === norm(want)) || opts.find((x) => norm(x.value) === norm(want)) || opts.find((x) => norm(x.label || x.text).includes(norm(want))); if (!o && /^\\d+$/.test(want)) o = opts[Number(want)]; if (!o) return { error: 'option_not_found', available: opts.slice(0, 50).map((x) => x.label || x.text) }; el.value = o.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { selected: o.value, label: o.label || o.text }; })()`, opts.aggressive) as { error?: string; available?: string[]; selected?: string; label?: string };
      if (res.error) throw new ActError(res.error, res.error === 'not_a_select' ? 'target is not a <select>; click it and choose the option like a user' : `no option matches "${spec.value}"`, undefined, res.available ? { available: res.available } : undefined);
      Object.assign(base, { method: 'dom', selected: res.selected, label: res.label });
      break;
    }
  }
  const settleMs = spec.settleMs ?? 600;
  if (settleMs > 0) { try { await executor.evaluate(tabId, settleJs(settleMs, Math.min(200, settleMs)), opts.aggressive, settleMs + 1500); } catch { /* navigation in flight */ } }
  try { await executor.evaluate(tabId, `document.querySelectorAll('[data-opencli-act]').forEach((n) => n.removeAttribute('data-opencli-act'))`, opts.aggressive, 1000); } catch { /* page changed */ }
  return base;
}
