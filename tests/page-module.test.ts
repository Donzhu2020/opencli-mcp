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

function rect(el: Element, r: { left: number; top: number; width: number; height: number }) {
  const full = { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => r } as DOMRect;
  Object.defineProperty(el, 'getBoundingClientRect', { value: () => full, configurable: true });
  Object.defineProperty(el, 'getClientRects', { value: () => [full], configurable: true });
}

async function page() { return await import('../extension/src/page/index.js'); }

beforeEach(() => { document.body.innerHTML = ''; });

describe('resolve', () => {
  it('accepts several matches only when exactly one is visible, else selector_ambiguous with candidates', async () => {
    document.body.innerHTML = '<button id="a">Go</button><button id="b" hidden>Go</button><button id="c">Go</button>';
    for (const id of ['a', 'b', 'c']) rect(document.getElementById(id)!, { left: 0, top: 0, width: 50, height: 20 });
    stubEngine();
    const p = await page();
    const amb = await p.resolve({ selector: 'button', fallback: null, strict: true, states: ['visible'], align: { block: 'center', inline: 'nearest' } });
    expect(amb).toMatchObject({ error: { code: 'selector_ambiguous' }, retry: false });
    expect((amb as { error: { candidates: unknown[] } }).error.candidates).toHaveLength(3);
    document.getElementById('c')!.setAttribute('hidden', '');
    const ok = await p.resolve({ selector: 'button', fallback: null, strict: true, states: ['visible'], align: { block: 'center', inline: 'nearest' } });
    expect(ok).toMatchObject({ ok: true, selector: '#a', matches_n: 3 });
  });
});

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
  it('keeps repeated visible lines and skips hidden text in one stable capture', async () => {
    document.body.innerHTML = '<p>Same</p><p>Same</p><p hidden>Secret</p><p aria-hidden="true">Shown</p>';
    installScroll(100, 100);
    const p = await page();
    const first = await p.readText({ waitMs: 0, maxChars: 5 });
    document.body.innerHTML = '<p>Changed</p>';
    const rest = await p.readText({ readId: first.readId, start: first.nextStart, maxChars: 20 });
    expect(first.text + rest.text).toBe('Same\nSame\nShown');
    expect(rest.complete).toBe(true);
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
  it('mounts one lazy chunk, and stops when every nudge grows the page', async () => {
    document.body.innerHTML = '<article><p>Intro</p></article>';
    const sc = installScroll(100, 100, (y) => {
      if (sc.scrollHeight > 100 || y <= 0) return;
      sc.scrollHeight = 250;
      const n = document.createElement('p');
      n.textContent = 'Mounted later';
      document.body.appendChild(n);
    });
    stubEngine();
    const p = await page();
    const lazy = await p.readText({ waitMs: 0, maxSteps: 6 });
    expect(lazy.complete).toBe(true);
    expect(lazy.text).toContain('Intro');
    expect(lazy.text).toContain('Mounted later');
    expect(sc.y).toBe(0);

    document.body.innerHTML = '<article><p>Intro</p></article>';
    const feed = installScroll(100, 100, (y) => {
      if (y + 100 < feed.scrollHeight - 1) return;
      feed.scrollHeight += 30;
      const n = document.createElement('p');
      n.textContent = `chunk ${feed.scrollHeight}`;
      document.body.appendChild(n);
    });
    const grown = await p.readText({ waitMs: 0, maxSteps: 6 });
    expect(grown.complete).toBe(false);
    expect(grown.reason).toBe('unbounded');
    expect(grown.text).toContain('chunk');
    expect(feed.y).toBe(0);
  });
});

describe('action map collapse', () => {
  it('collapses the largest ref branch and opens it again by ref', async () => {
    document.body.innerHTML = '<nav id="n"></nav><a id="h">Home</a><a id="a">About</a><main id="m"></main><button id="s">Save</button>';
    const [n, h, a, m, s] = ['n', 'h', 'a', 'm', 's'].map((id) => document.getElementById(id)!);
    const tree = ['- navigation [ref=e1]', '  - link "Home" [ref=e2]', '  - link "About" [ref=e3]', '- main [ref=e4]', '  - button "Save" [ref=e5]'].join('\n');
    stubEngine({ ariaText: tree, refs: { e1: n, e2: h, e3: a, e4: m, e5: s } });
    const p = await page();
    const collapsed = p.aria({ budget: 40 });
    expect(collapsed).toContain('[ref=e1] (collapsed)');
    expect(collapsed).not.toContain('Home');
    expect(collapsed).toContain('Observe again with that ref');
    const opened = p.aria({ ref: 'e1', budget: 5000 });
    expect(opened).toContain('Home');
    expect(opened).toContain('About');
    expect(opened).not.toContain('Save');
    expect(p.aria({ ref: 'e9', budget: 5000 })).toContain('No node [ref=e9]');
  });
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

it('finds a named control in the action map without a locator', async () => {
  document.body.innerHTML = '<main id="m"><button id="save">Save draft</button></main>';
  const main = document.getElementById('m')!;
  const save = document.getElementById('save')!;
  stubEngine({ ariaText: '- main [ref=e1]\n  - button "Save draft" [ref=e2]', refs: { e1: main, e2: save } });
  const p = await page();
  expect(p.findByQuery({ query: 'save', limit: 10 })).toMatchObject({ matches_n: 1, entries: [expect.objectContaining({ ref: 'e2', interactiveAncestorRef: 'e2', path: ['- main [ref=e1]'] })] });
});
