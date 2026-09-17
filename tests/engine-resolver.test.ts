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
