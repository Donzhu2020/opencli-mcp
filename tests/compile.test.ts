import { describe, expect, it } from 'vitest';
import { compileFromTrace } from '../src/sites/define.js';
import type { TraceEvent, TraceInput } from '../src/runtime/trace.js';

const t = (e: TraceInput): TraceEvent => ({ t: 1, ...e } as TraceEvent);

describe('tools_compile: frozen flows run on the agent engine with checkpoints', () => {
  it('freezes the locator intent, expect checkpoints, explicit args and structured step failures', () => {
    const trace: TraceEvent[] = [
      t({ kind: 'goto', url: 'https://shop.example/search' }),
      t({ kind: 'act', action: 'fill', target: 'label:Search', targetSpec: { label: 'Search' }, targetSelector: 'internal:label="Search"i', value: 'red shoes', ok: true }),
      t({ kind: 'act', action: 'press', target: 'label:Search', targetSpec: { label: 'Search' }, targetSelector: 'internal:label="Search"i', value: 'Enter', ok: true }),
      t({ kind: 'expect', what: { text: 'Results for red shoes', url: '/search?q=red' }, ok: true }),
      t({ kind: 'act', action: 'click', target: 'text:Nope', targetSpec: { text: 'Nope' }, ok: false }),
      t({ kind: 'act', action: 'click', target: 'ref:e7', targetSpec: { ref: 'e7' }, targetSelector: 'div > div:nth-child(3) > a', ok: true }),
      t({ kind: 'observe', mode: 'aria', summary: 'Results' }),
    ];
    const strict = compileFromTrace(trace, { site: 'shop', name: 'search', description: 'Search the shop', inputs: { query: { sample: 'red shoes', description: 'search terms' } } });
    expect(strict.func).toContain('tab.expect({"text":"Results for red shoes","url":"/search?q=red"})'); // exact by default: a checkpoint is never parameterized by guessing
    const def = compileFromTrace(trace, { site: 'shop', name: 'search', description: 'Search the shop', inputs: { query: { sample: 'red shoes', description: 'search terms', mode: 'within' } } });
    expect(def.args).toEqual([{ name: 'query', type: 'string', required: true, help: 'search terms' }]);
    const f = def.func!;
    expect(f).toContain('tab.act({ action: "fill", target: {"label":"Search"}, value: `${args.query}` })'); // the intent, not the resolved selector
    expect(f).toContain('tab.act({ action: "press", target: {"label":"Search"}, value: "Enter" })');
    expect(f).toContain('target: {"selector":"div > div:nth-child(3) > a"}'); // a one-time ref has no intent: the replay selector is frozen…
    expect(f).toContain('// REVIEW: acted on aria ref e7 (one-time)');
    expect(def.warnings).toHaveLength(1); expect(def.warnings?.[0]).toMatch(/^step 5: acted on aria ref e7 \(one-time\)/); // …and the tool is flagged
    expect(strict.warnings?.[0]).toMatch(/replace with a stable locator/);
    expect(f).toContain('tab.expect({"text":`Results for ${args.query}`,"url":"/search?q=red"})');
    expect(f).toContain('// checkpoint text follows the input (declared mode "within")');
    expect(f).not.toContain('Nope'); // failed steps are not frozen
    expect(f).toContain('return await tab.observe({ diff: false });');
    expect(f.startsWith('async ({ tab, args }) =>')).toBe(true);
    expect(f).toContain('const step = async (n, label, fn)');
    expect(() => new Function(`return (${f});`)).not.toThrow();
  });
  it('prefers a captured JSON endpoint', () => {
    const trace: TraceEvent[] = [t({ kind: 'goto', url: 'https://shop.example/' }), t({ kind: 'network', url: 'https://shop.example/api/items?q=red', contentType: 'application/json', status: 200, bodyBytes: 900 })];
    const exact = compileFromTrace(trace, { site: 'shop', name: 'items', description: 'Items', inputs: { q: 'red' } });
    expect(exact.func).toContain('tab.fetchJson("https://shop.example/api/items?q=red")');
    const def = compileFromTrace(trace, { site: 'shop', name: 'items', description: 'Items', inputs: { q: { sample: 'red', mode: 'within' } } });
    expect(def.func).toContain('tab.fetchJson(`https://shop.example/api/items?q=${args.q}`)');
  });
});
