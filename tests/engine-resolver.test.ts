import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { resolveJs, ENGINE_GLOBAL } from '../src/shared/engine.js';
import type { ActSpec } from '../src/protocol.js';

/**
 * The resolver is page-side JavaScript shipped as a string; nothing in the Node test suite executes it, so
 * a ReferenceError (e.g. a const used before its declaration) only showed up in the browser. This runs it in a
 * vm context with a stub DOM and a stub InjectedScript so the control flow is exercised end to end.
 */
function stubElement(tag: string, extra: Record<string, unknown> = {}) {
  const attrs = new Map<string, string>();
  return {
    tagName: tag.toUpperCase(), type: extra.type ?? '', isConnected: true, innerText: 'Click me', textContent: 'Click me',
    getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => { attrs.set(k, v); }, removeAttribute: (k: string) => { attrs.delete(k); },
    hasAttribute: (k: string) => attrs.has(k), getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 30 }), scrollIntoView: () => {},
    ...extra,
  };
}

function runResolver(spec: ActSpec, el: ReturnType<typeof stubElement> | null) {
  const matches = el ? [el] : [];
  const injected = {
    parseSelector: (s: string) => ({ parts: [s] }),
    querySelectorAll: () => matches,
    elementState: (node: unknown, state: string) => {
      if (state === 'checked' && !(node as { type?: string }).type) throw new Error('Not a checkbox or radio button');
      if (state === 'editable' && (node as { tagName: string }).tagName === 'BUTTON') throw new Error('Element is not an <input>, <textarea>, <select> or [contenteditable]');
      return { matches: true, received: state };
    },
    expectHitTarget: () => 'done',
    generateSelector: () => ({ selector: 'internal:role=button[name="Click me"i]' }),
  };
  const doc = { querySelectorAll: () => ({ forEach: () => {} }) };
  const ctx = vm.createContext({ [ENGINE_GLOBAL]: injected, document: doc, innerWidth: 1280, innerHeight: 800, performance: { now: () => Date.now() }, setTimeout, console });
  const js = resolveJs('internal:text="Click me"i', null, spec, { block: 'center', inline: 'nearest' });
  return vm.runInContext(js, ctx) as Promise<Record<string, unknown>>;
}

describe('page-side resolver executes without reference errors', () => {
  it('resolves a button for click', async () => {
    const r = await runResolver({ kind: 'click', target: { text: 'Click me' } }, stubElement('button'));
    expect(r.ok).toBe(true);
    expect(r.tag).toBe('button');
    expect(r.editable).toBe(false); // the stub engine throws "not editable" for buttons; a throw must read as false, not crash
    expect(r.checkable).toBe(false);
    expect(r.checked).toBe(false);
    expect(r.hit).toBe('target');
    expect(r.selector).toContain('internal:role');
  });
  it('resolves a text input for fill even though "checked" does not apply', async () => {
    const r = await runResolver({ kind: 'fill', target: { label: 'Name' }, value: 'Alice' }, stubElement('input', { type: 'text' }));
    expect(r.ok).toBe(true);
    expect(r.checkable).toBe(false);
  });
  it('reports not_editable with the engine reason when filling a button', async () => {
    const r = await runResolver({ kind: 'fill', target: { text: 'Click me' }, value: 'x' }, stubElement('button'));
    expect((r.error as { code: string }).code).toBe('not_editable');
    expect((r.error as { message: string }).message).toContain('not an <input>');
  });
  it('reports not_found when nothing matches', async () => {
    const r = await runResolver({ kind: 'click', target: { text: 'Nope' } }, null);
    expect((r.error as { code: string }).code).toBe('not_found');
  });
});

describe('frame probe (edge routing for cross-origin iframes)', () => {
  it('marks a cross-origin iframe and reports its viewport offset', async () => {
    const { frameProbeJs, FRAME_MARK } = await import('../src/shared/engine.js');
    const attrs = new Map<string, string>();
    const iframe = { contentWindow: { get document() { throw new Error('cross-origin'); } }, clientLeft: 2, clientTop: 3, src: 'https://other.example/', scrollIntoView: () => {}, getBoundingClientRect: () => ({ left: 100, top: 200, width: 300, height: 150 }), setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k) };
    const doc = { querySelectorAll: (sel: string) => (sel === 'iframe,frame' ? [iframe] : []) };
    const ctx = vm.createContext({ [ENGINE_GLOBAL]: {}, document: doc });
    const r = vm.runInContext(frameProbeJs(0), ctx) as { found: boolean; sameOrigin: boolean; x: number; y: number };
    expect(r).toMatchObject({ found: true, sameOrigin: false, x: 102, y: 203 });
    expect(attrs.get(FRAME_MARK)).toBe('1');
    expect(vm.runInContext(frameProbeJs(3), ctx)).toEqual({ found: false });
  });
});

describe('aria snapshot generator', () => {
  it('is valid page code and redacts credential values', async () => {
    const { ariaSnapshotJs } = await import('../src/shared/engine.js');
    class HTMLInputElement { type = 'text'; attrs = new Map<string, string>(); getAttribute(k: string) { return this.attrs.get(k) ?? null; } }
    class HTMLTextAreaElement {}
    const pw = new HTMLInputElement(); pw.type = 'password';
    const email = new HTMLInputElement(); email.attrs.set('autocomplete', 'email');
    const name = new HTMLInputElement(); name.attrs.set('name', 'display');
    const info = new Map([['e1', { element: name }], ['e2', { element: pw }], ['e3', { element: email }]]);
    const text = ['- textbox "Name" [ref=e1]: Alice', '- textbox "Password" [ref=e2]: hunter2', '- textbox "Email" [ref=e3]: a@b.c', '- button "Go" [ref=e4]'].join('\n');
    const injected = { ariaSnapshot: () => text, _lastAriaSnapshotForQuery: { info } };
    const ctx = vm.createContext({ [ENGINE_GLOBAL]: injected, document: { body: {} }, HTMLInputElement, HTMLTextAreaElement });
    const out = vm.runInContext(ariaSnapshotJs(), ctx) as string;
    expect(out.split('\n')).toEqual(['- textbox "Name" [ref=e1]: Alice', '- textbox "Password" [ref=e2]: <redacted>', '- textbox "Email" [ref=e3]: <redacted>', '- button "Go" [ref=e4]']);
  });
});
