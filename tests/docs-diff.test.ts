import { describe, expect, it } from 'vitest';
import { buildInstructions, listDocs, requiredDocsFor, readDoc } from '../src/docs/manifest.js';
import { lineDiff } from '../src/api/diff.js';
import { compileFromTrace, renderToolModule, validateDefinition } from '../src/sites/define.js';

describe('docs manifest', () => {
  it('builds instructions per backend and gates cdp', () => {
    const ext = buildInstructions({ backend: 'extension', capabilities: [] });
    const none = buildInstructions({ backend: 'none', capabilities: [] });
    expect(ext).toContain('Tabs are the user');
    expect(none).not.toContain('Tabs are the user');
    expect(readDoc('js-tool')).toContain('agent.browsers');
    expect(requiredDocsFor('cdp_send', { backend: 'extension', capabilities: ['cdp'] })).toEqual([]); // no typed cdp tool any more: the capability doc is returned by browser.capabilities.get('cdp') in js
    expect(listDocs({ backend: 'none', capabilities: [] }).find((d) => d.name === 'tab-lifecycle')?.available).toBe(false);
  });
});

describe('line diff', () => {
  it('reports small changes as diffs', () => {
    const d = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne');
    expect(d.added).toBe(2); expect(d.removed).toBe(1); expect(d.changedRatio).toBeLessThan(0.7);
    expect(d.text).toContain('- b'); expect(d.text).toContain('+ B'); expect(d.text).toContain('+ e');
  });
});

describe('tools.define', () => {
  it('renders a valid adapter module and compiles a trace', () => {
    const def = { site: 'demo', name: 'thing', description: 'd', access: 'read' as const, args: [{ name: 'q', required: true }], func: 'async (page, args) => { await page.goto("https://x.test/?q=" + args.q); return await page.snapshot(); }' };
    validateDefinition(def);
    const mod = renderToolModule(def);
    expect(mod).toContain("import { cli, Strategy } from '@jackwener/opencli/registry'");
    expect(mod).toContain('Strategy.COOKIE'); expect(mod).toContain('browser: true');
    expect(() => validateDefinition({ ...def, func: 'not a function {' })).toThrow(/parse/);
    const draft = compileFromTrace([
      { t: 1, kind: 'goto', url: 'https://x.test/search?q=shoes' },
      { t: 2, kind: 'act', action: 'fill', target: 'css:#q', targetRef: '12', value: 'shoes', ok: true },
      { t: 3, kind: 'act', action: 'press', target: 'ref:12', value: 'Enter', ok: true },
    ], { site: 'x', name: 'search', description: 's', inputs: { query: 'shoes' } });
    expect(draft.func).toContain('args.query'); expect(draft.args?.[0].name).toBe('query');
    const net = compileFromTrace([{ t: 1, kind: 'goto', url: 'https://x.test/' }, { t: 2, kind: 'network', url: 'https://x.test/api/list?q=shoes', method: 'GET', status: 200, contentType: 'application/json', bodyBytes: 900 }], { site: 'x', name: 'list', description: 'l', inputs: { q: { sample: 'shoes', mode: 'within' } }, domain: 'x.test' });
    expect(net.func).toContain('page.fetchJson(`https://x.test/api/list?q=${args.q}`)');
  });
});
