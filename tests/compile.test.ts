import { describe, expect, it } from 'vitest';
import { compileFromTrace } from '../src/sites/define.js';
import type { TraceEvent, TraceInput } from '../src/runtime/trace.js';

const t = (e: TraceInput): TraceEvent => ({ t: 1, ...e } as TraceEvent);

describe('tools_compile: frozen flows run on the agent engine with checkpoints', () => {
  it('emits act steps with replay selectors, expect checkpoints, explicit args and structured step failures', () => {
    const trace: TraceEvent[] = [
      t({ kind: 'goto', url: 'https://shop.example/search' }),
      t({ kind: 'act', action: 'fill', target: 'label:Search', targetSpec: { label: 'Search' }, targetSelector: 'internal:label="Search"i', value: 'red shoes', ok: true }),
      t({ kind: 'act', action: 'press', target: 'label:Search', targetSpec: { label: 'Search' }, targetSelector: 'internal:label="Search"i', value: 'Enter', ok: true }),
      t({ kind: 'expect', what: { text: 'Results for red shoes', url: '/search?q=red' }, ok: true }),
      t({ kind: 'act', action: 'click', target: 'text:Nope', targetSpec: { text: 'Nope' }, ok: false }),
      t({ kind: 'observe', mode: 'aria', summary: 'Results' }),
    ];
    const def = compileFromTrace(trace, { site: 'shop', name: 'search', description: 'Search the shop', inputs: { query: { sample: 'red shoes', description: 'search terms' } } });
    expect(def.args).toEqual([{ name: 'query', type: 'string', required: true, help: 'search terms' }]);
    const f = def.func!;
    expect(f).toContain('page.act({ kind: "fill", target: {"selector":"internal:label=\\"Search\\"i"}, value: `${args.query}` })');
    expect(f).toContain('page.act({ kind: "press", target: {"selector":"internal:label=\\"Search\\"i"}, value: "Enter" })');
    expect(f).toContain('page.expect({"text":`Results for ${args.query}`,"url":"/search?q=red"})');
    expect(f).not.toContain('Nope'); // failed steps are not frozen
    expect(f).toContain('return await page.aria();');
    expect(f).toContain('const step = async (n, label, fn)');
    expect(() => new Function(`return (${f});`)).not.toThrow();
  });
  it('prefers a captured JSON endpoint', () => {
    const trace: TraceEvent[] = [t({ kind: 'goto', url: 'https://shop.example/' }), t({ kind: 'network', url: 'https://shop.example/api/items?q=red', contentType: 'application/json', status: 200, bodyBytes: 900 })];
    const def = compileFromTrace(trace, { site: 'shop', name: 'items', description: 'Items', inputs: { q: 'red' } });
    expect(def.func).toContain('page.fetchJson(`https://shop.example/api/items?q=${args.q}`)');
  });
});
