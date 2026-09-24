// @vitest-environment jsdom
/** Exercise the page-side module under jsdom with a minimal InjectedScript stub. */
import { beforeEach, describe, expect, it } from 'vitest';
import { ENGINE_GLOBAL } from '../src/shared/page-contract.js';

type AnyEl = Element & { hiddenForTest?: boolean };

function stubEngine(opts: { ariaText?: string; refs?: Record<string, Element> } = {}) {
  const info = new Map(Object.entries(opts.refs ?? {}).map(([ref, element]) => [ref, { element }]));
  const engine = {
    parseSelector: (s: string) => s,
    querySelectorAll: (sel: string, root: ParentNode) => {
      if (sel.startsWith('aria-ref=')) { const e = info.get(sel.slice(9))?.element; return e ? [e] : []; }
      if (sel.startsWith('internal:text=')) { const t = JSON.parse(sel.slice(14).replace(/i$/, '')); return [...root.querySelectorAll('*')].filter((e) => e.children.length === 0 && (e.textContent ?? '').trim() === t); }
      if (sel.startsWith('internal:label=')) return [];
      if (sel.startsWith('internal:attr=[placeholder=')) { const p = JSON.parse(sel.slice('internal:attr=[placeholder='.length).replace(/i\]$/, '')); return [...root.querySelectorAll(`[placeholder="${p}"]`)]; }
      return [...root.querySelectorAll(sel)];
    },
    elementState: (el: AnyEl, st: string) => {
      if (st === 'checked') { if (!(el instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(el.type)) throw new Error('Not a checkbox or radio button'); return { matches: el.checked }; }
      if (st === 'editable') { if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error('Element is not an <input>, <textarea>, <select> or [contenteditable]'); return { matches: !el.readOnly && !el.disabled }; }
      if (st === 'enabled') return { matches: !(el as HTMLButtonElement).disabled };
      if (st === 'visible') return { matches: !el.hiddenForTest && !el.hasAttribute('hidden') };
      return { matches: true };
    },
    expectHitTarget: () => 'done',
    generateSelector: (el: Element) => ({ selector: el.id ? `#${el.id}` : el.tagName.toLowerCase() }),
    ariaSnapshot: () => opts.ariaText ?? '',
    _lastAriaSnapshotForQuery: { info },
  };
  (globalThis as Record<string, unknown>)[ENGINE_GLOBAL] = engine;
  return engine;
}
async function page() { return await import('../extension/src/page/index.js'); }

beforeEach(() => { document.body.innerHTML = ''; });

describe('observation: aria is the one state source', () => {
  it('keeps a ref pinned to its element when a node is inserted above it (Playwright would renumber)', async () => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    const a = document.getElementById('a')!; const b = document.getElementById('b')!;
    // first snapshot: Playwright hands out e1→a, e2→b (tree order)
    stubEngine({ ariaText: ['- button "A" [ref=e1]', '- button "B" [ref=e2]'].join('\n'), refs: { e1: a, e2: b } });
    const p = await page();
    expect(p.aria().split('\n')).toEqual(['- button "A" [ref=e1]', '- button "B" [ref=e2]']);
    // a banner is inserted at the top: Playwright now numbers banner=e1, a=e2, b=e3 — but the SAME engine, so our ids hold
    const banner = document.createElement('div'); document.body.insertBefore(banner, a);
    (globalThis as Record<string, unknown>)[ENGINE_GLOBAL] = Object.assign((globalThis as Record<string, unknown>)[ENGINE_GLOBAL] as object, {
      ariaSnapshot: () => ['- generic [ref=e1]', '- button "A" [ref=e2]', '- button "B" [ref=e3]'].join('\n'),
      _lastAriaSnapshotForQuery: { info: new Map<string, { element: Element }>([['e1', { element: banner }], ['e2', { element: a }], ['e3', { element: b }]]) },
    });
    // a and b keep e1/e2; the banner is the new identity e3 (max+1), not e1
    expect(p.aria().split('\n')).toEqual(['- generic [ref=e3]', '- button "A" [ref=e1]', '- button "B" [ref=e2]']);
    // a ref held from the first snapshot still resolves to the same element after the insert
    expect(p.check({ ref: 'e2' }).ok).toBe(true); // e2 still resolves (to button B) after the insert
    expect(p.find({ selector: 'aria-ref=e2', fallback: null, limit: 1 }).matches_n).toBe(1);
  });
});
describe('readText', () => {
  it('continues a bounded read using nextStart without repeating the head', async () => {
    document.body.innerHTML = '<article><p>Alpha</p><p>Bravo</p><p>Charlie</p></article>';
    installScroll(100, 100);
    const p = await page();
    const first = await p.readText({ waitMs: 0, maxChars: 7 });
    expect(first).toMatchObject({ text: 'Alpha\nB', complete: false, reason: 'budget', start: 0, nextStart: 7 });
    const second = await p.readText({ readId: first.readId, maxChars: 7, start: first.nextStart });
    expect(second).toMatchObject({ text: 'ravo\nCh', complete: false, start: 7, nextStart: 14 });
    const last = await p.readText({ readId: second.readId, maxChars: 7, start: second.nextStart });
    expect(last).toMatchObject({ text: 'arlie', complete: true, start: 14 });
    expect(first.text + second.text + last.text).toBe('Alpha\nBravo\nCharlie');
  });
  function installScroll(height: number, scrollHeight0: number, onScroll?: (y: number) => void) {
    let y = 0;
    let scrollHeight = scrollHeight0;
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => height });
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y });
    Object.defineProperty(document.documentElement, 'scrollTop', { configurable: true, get: () => y, set: (v: number) => { y = Number(v); onScroll?.(y); } });
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, get: () => height });
    window.scrollTo = ((x?: number | ScrollToOptions, yy?: number) => {
      const next = typeof x === 'number' ? (yy ?? 0) : (x?.top ?? 0);
      document.documentElement.scrollTop = next;
    }) as typeof window.scrollTo;
    return {
      get y() { return y; }, set y(v: number) { y = v; },
      get scrollHeight() { return scrollHeight; }, set scrollHeight(v: number) { scrollHeight = v; },
    };
  }
});
it('exposes a hidden file input and resolves it without a layout box', async () => {
  document.body.innerHTML = '<input id="upload" type="file" hidden accept="image/png">';
  stubEngine();
  const p = await page();
  const state = p.aria();
  expect(state).toContain('file-input "file upload" [ref=e1] (hidden)');
  expect(p.resolveUpload({ selector: 'aria-ref=e1', fallback: null, files: 1 })).toMatchObject({ ok: true, ref: 'e1' });
  expect(document.getElementById('upload')?.hasAttribute('data-opencli-act')).toBe(true);
  expect(p.resolveUpload({ selector: 'aria-ref=e1', fallback: null, files: 2 })).toMatchObject({ error: { code: 'invalid_args' } });
});
