// @vitest-environment jsdom
/**
 * The page-side module runs as real code under jsdom with a stub of Playwright's InjectedScript: what used to be
 * string templates (and shipped two ReferenceErrors) is now type-checked and executed here.
 */
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
    retarget: (el: Element) => el,
    focusNode: (el: HTMLElement) => { el.focus(); return 'done'; },
    fill: () => 'needsinput',
    selectOptions: (el: HTMLSelectElement, specs: Array<{ valueOrLabel?: string; index?: number }>) => {
      const opt = [...el.options].find((o) => o.value === specs[0].valueOrLabel || o.label === specs[0].valueOrLabel) ?? (specs[0].index !== undefined ? el.options[specs[0].index] : undefined);
      if (!opt) return 'error:optionsnotfound';
      el.value = opt.value; return [opt.value];
    },
    utils: { getAriaRole: (el: Element) => el.getAttribute('role') || (el.tagName === 'BUTTON' ? 'button' : el.tagName === 'A' ? 'link' : ''), getElementAccessibleNameText: (el: Element) => el.getAttribute('aria-label') || (el.textContent ?? '').trim() },
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
  it('locates a visible button, marks it, reports hit and replay selector', async () => {
    document.body.innerHTML = '<button id="go">Click me</button>';
    const btn = document.getElementById('go')!; rect(btn, { left: 10, top: 20, width: 100, height: 30 });
    stubEngine();
    const p = await page();
    const r = await p.resolve({ selector: 'internal:text="Click me"i', fallback: null, strict: true, states: ['visible', 'enabled'], align: { block: 'center', inline: 'nearest' } });
    expect(r).toMatchObject({ ok: true, tag: 'button', hit: 'target', checkable: false, checked: false, selector: '#go', x: 60, y: 35 });
    expect(btn.hasAttribute('data-opencli-act')).toBe(true);
    expect(p.focus()).toBe('done');
    p.clearActMark();
    expect(btn.hasAttribute('data-opencli-act')).toBe(false);
  });
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
  it('reports not_editable with the engine reason and not_found / fallback', async () => {
    document.body.innerHTML = '<button id="go">Go</button><input id="q" placeholder="Search">';
    rect(document.getElementById('go')!, { left: 0, top: 0, width: 50, height: 20 });
    rect(document.getElementById('q')!, { left: 0, top: 30, width: 50, height: 20 });
    stubEngine();
    const p = await page();
    const ne = await p.resolve({ selector: '#go', fallback: null, strict: true, states: ['visible', 'enabled', 'editable'], align: { block: 'center', inline: 'nearest' } });
    expect(ne).toMatchObject({ error: { code: 'not_editable' } });
    expect((ne as { error: { message: string } }).error.message).toContain('not an <input>');
    const nf = await p.resolve({ selector: '#nope', fallback: null, strict: true, states: ['visible'], align: { block: 'center', inline: 'nearest' } });
    expect(nf).toMatchObject({ error: { code: 'not_found' }, retry: true });
    const fb = await p.resolve({ selector: 'internal:label="Search"i', fallback: 'internal:attr=[placeholder="Search"i]', strict: true, states: ['visible', 'enabled', 'editable'], align: { block: 'center', inline: 'nearest' } });
    expect(fb).toMatchObject({ ok: true, tag: 'input', editable: true, usedSelector: 'internal:attr=[placeholder="Search"i]' });
  });
});

describe('actions on the marked element', () => {
  it('fills through native setter fallback, reads value, checks, selects', async () => {
    document.body.innerHTML = '<input id="name"><input id="agree" type="checkbox"><select id="s"><option value="1">One</option><option value="2">Two</option></select>';
    for (const id of ['name', 'agree', 's']) rect(document.getElementById(id)!, { left: 0, top: 0, width: 50, height: 20 });
    stubEngine();
    const p = await page();
    await p.resolve({ selector: '#name', fallback: null, strict: true, states: ['visible'], align: { block: 'center', inline: 'nearest' } });
    expect(p.fill({ value: 'Alice' })).toBe('needsinput');
    expect(p.nativeSet({ value: 'Alice' })).toBe(true);
    expect(p.readValue()).toBe('Alice');
    await p.resolve({ selector: '#agree', fallback: null, strict: true, states: ['visible'], align: { block: 'center', inline: 'nearest' } });
    expect(p.isChecked()).toBe(false);
    (document.getElementById('agree') as HTMLInputElement).checked = true;
    expect(p.isChecked()).toBe(true);
    await p.resolve({ selector: '#s', fallback: null, strict: true, states: ['visible'], align: { block: 'center', inline: 'nearest' } });
    expect(p.select({ value: 'Two' })).toEqual({ selected: ['2'] });
    expect(p.select({ value: 'Nine' })).toMatchObject({ error: 'optionsnotfound', available: ['One', 'Two'] });
  });
  it('settles when the DOM goes quiet', async () => {
    stubEngine();
    const p = await page();
    const t = setInterval(() => document.body.appendChild(document.createElement('i')), 20);
    setTimeout(() => clearInterval(t), 120);
    const r = await p.settle({ maxMs: 1000, quietMs: 100 });
    expect(r.quiet).toBe(true);
    expect(r.waitedMs).toBeGreaterThan(150);
  });
});

describe('observation: aria is the one state source', () => {
  it('redacts credential values, filters to the viewport, and maps refs both ways', async () => {
    document.body.innerHTML = '<input id="n" name="display"><input id="p" type="password"><input id="cc" autocomplete="cc-number"><button id="far">Far</button>';
    const [n, pw, cc, far] = ['n', 'p', 'cc', 'far'].map((id) => document.getElementById(id)!);
    rect(n, { left: 0, top: 0, width: 50, height: 20 }); rect(pw, { left: 0, top: 30, width: 50, height: 20 }); rect(cc, { left: 0, top: 60, width: 50, height: 20 });
    rect(far, { left: 0, top: 5000, width: 50, height: 20 });
    const text = ['- textbox "Name" [ref=e1]: Alice', '- textbox "Password" [ref=e2]: hunter2', '- textbox "Card" [ref=e3]: 4111', '- button "Far" [ref=e4]', '  - text: nested', '- text: trailing'].join('\n');
    stubEngine({ ariaText: text, refs: { e1: n, e2: pw, e3: cc, e4: far } });
    const p = await page();
    expect(p.aria().split('\n')).toEqual(['- textbox "Name" [ref=e1]: Alice', '- textbox "Password" [ref=e2]: <redacted>', '- textbox "Card" [ref=e3]: <redacted>', '- button "Far" [ref=e4]', '  - text: nested', '- text: trailing']);
    expect(p.aria({ viewport: true }).split('\n')).toEqual(['- textbox "Name" [ref=e1]: Alice', '- textbox "Password" [ref=e2]: <redacted>', '- textbox "Card" [ref=e3]: <redacted>', '- text: trailing']);
    expect(p.ariaRefOf(pw)).toBe('e2');
    const f = p.find({ selector: 'input', fallback: null, limit: 10 });
    expect(f.matches_n).toBe(3);
    expect(f.entries.map((e) => e.ref)).toEqual(['e1', 'e2', 'e3']);
    expect(f.entries[1].attrs.value).toBeUndefined();
    expect(p.annotate()).toBe(3); // the offscreen button gets no label
    expect(document.getElementById('opencli-mcp-annotate')).not.toBeNull();
    p.unannotate();
    expect(document.getElementById('opencli-mcp-annotate')).toBeNull();
  });
  it('describes the element under a point with its ancestors', async () => {
    document.body.innerHTML = '<div id="wrap"><a id="l" href="/x">Link</a></div>';
    stubEngine({ refs: { e7: document.getElementById('l')! } });
    document.elementFromPoint = () => document.getElementById('l');
    const p = await page();
    const r = p.elementAt({ x: 5, y: 5 });
    expect(r.matches_n).toBe(2);
    expect(r.entries[0]).toMatchObject({ tag: 'a', role: 'link', ref: 'e7', selector: '#l' });
    expect(r.entries[1]).toMatchObject({ tag: 'div', selector: '#wrap' });
  });
});

describe('frames', () => {
  it('marks a cross-origin iframe and reports its offset', async () => {
    document.body.innerHTML = '<iframe id="f" src="https://other.example/"></iframe>';
    const f = document.getElementById('f')!; rect(f, { left: 100, top: 200, width: 300, height: 150 });
    stubEngine();
    const p = await page();
    const r = p.frameProbe({ step: 0 });
    expect(r).toMatchObject({ found: true, x: 100, y: 200 });
    expect(f.hasAttribute('data-opencli-frame')).toBe(true);
    p.clearFrameMark();
    expect(f.hasAttribute('data-opencli-frame')).toBe(false);
    expect(p.frameProbe({ step: 3 })).toEqual({ found: false });
  });
});

describe('check', () => {
  it('evaluates text, url, title, selector and absence expectations', async () => {
    document.body.innerHTML = '<h1>Results for red shoes</h1><button id="b">Go</button>';
    document.title = 'Shop';
    rect(document.getElementById('b')!, { left: 0, top: 0, width: 50, height: 20 });
    stubEngine();
    const p = await page();
    expect(p.check({ text: 'Results for red', title: 'Shop', selector: '#b' })).toMatchObject({ ok: true, failed: [] });
    const r = p.check({ text: 'blue', url: 'nowhere', selector: '#zzz', notText: 'red' });
    expect(r.ok).toBe(false);
    expect(r.failed).toHaveLength(4);
    expect(p.check({ selector: '#zzz', visible: false })).toMatchObject({ ok: true });
  });
});
