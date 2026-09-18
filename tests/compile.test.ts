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
    expect(def.warnings?.find((w) => w.startsWith('step 5: acted on aria ref e7 (one-time)'))).toBeTruthy(); // …and the tool is flagged
    expect(strict.warnings?.some((w) => /replace with a stable locator/.test(w))).toBe(true);
    expect(def.warnings?.some((w) => /no captured requests/.test(w))).toBe(true); // DOM fallback is always explained
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
    // a query value equal to the sample is the exact contract at the right granularity: it becomes the (encoded) argument
    expect(exact.func).toContain('tab.fetchJson(`https://shop.example/api/items?q=${encodeURIComponent(args.q)}`)');
    expect(exact.warnings?.some((w) => /chosen by size/.test(w))).toBe(true); // nothing extracted to match against
    const def = compileFromTrace(trace, { site: 'shop', name: 'items', description: 'Items', inputs: { q: { sample: 'red', mode: 'within' } } });
    expect(def.func).toContain('tab.fetchJson(`https://shop.example/api/items?q=${encodeURIComponent(args.q)}`)');
  });
  it('freezes the request that carried the data the agent extracted — headers and body included, credentials excluded', () => {
    const trace: TraceEvent[] = [
      t({ kind: 'goto', url: 'https://shop.example/search' }),
      t({ kind: 'network', url: 'https://shop.example/api/telemetry', method: 'POST', contentType: 'application/json', status: 200, bodyBytes: 90000, resourceType: 'Fetch', responseSample: '{"ok":true,"sessions":[]}' }),
      t({ kind: 'network', url: 'https://shop.example/graphql', method: 'POST', contentType: 'application/json', status: 200, bodyBytes: 4000, resourceType: 'Fetch', requestHeaders: { 'content-type': 'application/json', 'x-csrf-token': 'abc', accept: '*/*' }, auth: true, postData: '{"query":"q","variables":{"term":"red shoes"}}', responseSample: '{"data":{"items":[{"title":"Crimson Runner"},{"title":"Ruby Loafer"}]}}' }),
      t({ kind: 'network', url: 'https://cdn.example/assets/app.js', contentType: 'application/javascript', status: 200, bodyBytes: 500000 }),
      t({ kind: 'evaluate', code: '[...document.querySelectorAll(".title")].map(e => e.textContent)', result: '["Crimson Runner","Ruby Loafer"]' }),
    ];
    const def = compileFromTrace(trace, { site: 'shop', name: 'search', description: 'Search', inputs: { term: 'red shoes' } });
    const f = def.func!;
    expect(f).toContain('tab.fetchJson("https://shop.example/graphql", { method: "POST", headers: {"content-type":"application/json","accept":"*/*"}, body: JSON.stringify({"query":"q","variables":{"term":args.term}}) })'); // the CSRF token is per-session: named, not frozen
    expect(def.warnings?.some((w) => /x-csrf-token/.test(w) && /not frozen/.test(w))).toBe(true);
    expect(f).not.toContain('telemetry'); // the biggest response is not the answer; the one carrying the extracted values is
    expect(def.warnings?.some((w) => /matched 4 word/.test(w))).toBe(true);
    expect(def.warnings?.some((w) => /Authorization header/.test(w))).toBe(true);
    expect(() => new Function(`return (${f});`)).not.toThrow();
  });
});
