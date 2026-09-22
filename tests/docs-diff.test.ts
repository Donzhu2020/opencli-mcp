import { describe, expect, it } from 'vitest';
import { buildInstructions, listDocs, readDoc } from '../src/docs/manifest.js';
import { compileFromTrace, renderAdapterModule, validateDefinition } from '../src/sites/define.js';

describe('docs manifest', () => {
  it('builds instructions per backend and gates cdp', () => {
    const ext = buildInstructions({ backend: 'extension', capabilities: [] });
    const none = buildInstructions({ backend: 'none', capabilities: [] });
    expect(ext).toContain('Tabs are the user');
    expect(none).not.toContain('Tabs are the user');
    expect(readDoc('confirmations')).toBeNull();
    expect(ext).not.toMatch(/confirmWrites|askNewOrigins|allowOrigin/);
    expect(readDoc('js-tool')).toContain('agent.browsers');
    expect(readDoc('api-reference')).toContain('class Tab');
    expect(readDoc('api-reference')).not.toContain('use(fn');
    expect(readDoc('api-reference')).toContain('selected(): Promise<Tab | undefined>'); // a real union result is kept…
    expect(readDoc('api-reference')).not.toMatch(/\| undefined[,)]/); // …while `?` already expresses undefined for parameters
    expect(readDoc('errors')).toContain('selector_ambiguous');    expect(listDocs({ backend: 'none', capabilities: [] }).find((d) => d.name === 'tab-lifecycle')?.available).toBe(false);
  });
});

describe('tools.define', () => {
  it('renders a valid adapter module and compiles a trace', () => {
    const def = { site: 'demo', name: 'thing', description: 'd', access: 'read' as const, args: [{ name: 'q', required: true }], func: 'async ({ tab, args }) => { await tab.goto("https://x.test/?q=" + args.q); return await tab.observe(); }' };
    validateDefinition(def);
    const mod = renderAdapterModule(def);
    expect(mod).toContain("import { defineAdapter } from '@opencli-mcp/adapter-sdk'");
    expect(mod).toContain('export default defineAdapter({'); expect(mod).toContain('run: async ({ tab, args }) =>');
    expect(() => validateDefinition({ ...def, func: 'not a function {' })).toThrow(/parse/);
    const draft = compileFromTrace([
      { t: 1, kind: 'goto', url: 'https://x.test/search?q=shoes' },
      { t: 2, kind: 'act', action: 'fill', target: 'css:#q', targetRef: '12', value: 'shoes', ok: true },
      { t: 3, kind: 'act', action: 'press', target: 'ref:12', value: 'Enter', ok: true },
    ], [], { site: 'x', name: 'search', description: 's', inputs: { query: 'shoes' } });
    expect(draft.func).toContain('args.query'); expect(draft.args?.[0].name).toBe('query');
    const net = compileFromTrace([{ t: 1, kind: 'goto', url: 'https://x.test/' }], [{ url: 'https://x.test/api/list?q=shoes', method: 'GET', status: 200, contentType: 'application/json', bodyBytes: 900 }], { site: 'x', name: 'list', description: 'l', inputs: { q: { sample: 'shoes', mode: 'within' } }, domain: 'x.test' });
    expect(net.func).toContain('tab.fetchJson(`https://x.test/api/list?q=${encodeURIComponent(args.q)}`)');
  });
});

describe('aria diff', () => {
  it('diffs by ref identity like the plugin: ~ changed, + added, removed as ranges, focus kept out', async () => {
    const { ariaDiff } = await import('../src/api/diff.js');
    const prev = ['- textbox "Name" [ref=e1]: ', '- button "Go" [ref=e2]', '- link "A" [ref=e3]', '- link "B" [ref=e4]', '- link "C" [ref=e5]', '- text: hello'].join('\n');
    const next = ['- textbox "Name" [ref=e1]: Alice', '- button "Go" [ref=e2]', '- text: hello', '- alert "Saved" [ref=e9]'].join('\n');
    const d = ariaDiff(prev, next);
    expect(d.text.split('\n')).toEqual(['Diff from the previous observe: ~ changed, + added; removed nodes are listed by ref.', '~- textbox "Name" [ref=e1]: Alice', '+- alert "Saved" [ref=e9]', 'removed: e3–e5']);
    expect(d).toMatchObject({ added: 1, removed: 3, changed: 1 });
    expect(ariaDiff(prev, prev).text).toBe('');
  });
  it('scopes targets with within', async () => {
    const { targetToSelector, fallbackSelector } = await import('../src/shared/engine.js');
    expect(targetToSelector({ role: 'button', name: 'Close', within: '#checkout' })).toBe('#checkout >> internal:role=button[name="Close"i]');
    expect(targetToSelector({ text: 'Add to cart', within: 'e12' })).toBe('aria-ref=e12 >> internal:text="Add to cart"i');
    expect(fallbackSelector({ label: 'Search', within: 'nav' })).toBe('nav >> internal:attr=[placeholder="Search"i]');
  });
});
