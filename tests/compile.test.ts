import { describe, expect, it } from 'vitest';
import { compileFromTrace } from '../src/sites/define.js';
import type { TraceEvent, TraceInput, NetworkEvidence } from '../src/runtime/trace.js';

const t = (e: TraceInput): TraceEvent => ({ t: 1, ...e } as TraceEvent);
const n = (e: NetworkEvidence): NetworkEvidence => e; // network evidence is separate from the step trace

describe('tools_compile: frozen flows run on the agent engine with checkpoints', () => {
  it('never lets page data break the generated source (literal ${ and backticks are escaped)', () => {
    const trace: TraceEvent[] = [
      t({ kind: 'goto', url: 'https://x.test/p?q=${danger}`' }),
      t({ kind: 'act', action: 'fill', target: 'label:Note', targetSpec: { label: 'Note' }, targetSelector: 'internal:label="Note"i', value: 'pay ${amount} now `tick`', ok: true }),
    ];
    const net = [n({ url: 'https://x.test/api', method: 'POST', contentType: 'application/json', status: 200, bodyBytes: 50, resourceType: 'Fetch', requestHeaders: { 'content-type': 'application/json' }, postData: '{"note":"has ${x} and `tick`"}', responseSample: '{"ok":true}' })];
    const def = compileFromTrace(trace, net, { site: 'x', name: 'p', description: 'd', inputs: {} });
    const f = def.func!;
    expect(() => new Function(`return (${f});`)).not.toThrow();      // the source parses
    expect(f).not.toMatch(/[^\\]\$\{(?!args\.)/);                    // no unescaped foreign interpolation survives
  });

  it('rejects an input name that is not a JavaScript identifier', () => {
    const trace: TraceEvent[] = [t({ kind: 'goto', url: 'https://x.test/' })];
    const net = [n({ url: 'https://x.test/api?id=7', contentType: 'application/json', status: 200, bodyBytes: 10, resourceType: 'Fetch', responseSample: '{"id":7}' })];
    expect(() => compileFromTrace(trace, net, { site: 'x', name: 'p', description: 'd', inputs: { 'user-id': '7' } })).toThrow(/identifier/);
  });

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
    const strict = compileFromTrace(trace, [], { site: 'shop', name: 'search', description: 'Search the shop', inputs: { query: { sample: 'red shoes', description: 'search terms' } } });
    expect(strict.func).toContain('tab.expect({"text":"Results for red shoes","url":"/search?q=red"})'); // exact by default: a checkpoint is never parameterized by guessing
    const def = compileFromTrace(trace, [], { site: 'shop', name: 'search', description: 'Search the shop', inputs: { query: { sample: 'red shoes', description: 'search terms', mode: 'within' } } });
    expect(def.args).toEqual([{ name: 'query', type: 'string', required: true, help: 'search terms' }]);
    const f = def.func!;
    expect(f).toContain('tab.act({ action: "fill", target: {"label":"Search"}, value: args.query })'); // the intent, not the resolved selector
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
    const trace: TraceEvent[] = [t({ kind: 'goto', url: 'https://shop.example/' })];
    const net = [n({ url: 'https://shop.example/api/items?q=red', contentType: 'application/json', status: 200, bodyBytes: 900 })];
    const exact = compileFromTrace(trace, net, { site: 'shop', name: 'items', description: 'Items', inputs: { q: 'red' } });
    // a query value equal to the sample is the exact contract at the right granularity: it becomes the (encoded) argument
    expect(exact.func).toContain('tab.fetchJson(`https://shop.example/api/items?q=${encodeURIComponent(args.q)}`)');
    expect(exact.warnings?.some((w) => /chosen by size/.test(w))).toBe(true); // nothing extracted to match against
    const def = compileFromTrace(trace, net, { site: 'shop', name: 'items', description: 'Items', inputs: { q: { sample: 'red', mode: 'within' } } });
    expect(def.func).toContain('tab.fetchJson(`https://shop.example/api/items?q=${encodeURIComponent(args.q)}`)');
  });
  it('freezes the request that carried the data the agent extracted — headers and body included, credentials excluded', () => {
    const trace: TraceEvent[] = [
      t({ kind: 'goto', url: 'https://shop.example/search' }),
      t({ kind: 'evaluate', code: '[...document.querySelectorAll(".title")].map(e => e.textContent)', result: '["Crimson Runner","Ruby Loafer"]' }),
    ];
    const net = [
      n({ url: 'https://shop.example/api/telemetry', method: 'POST', contentType: 'application/json', status: 200, bodyBytes: 90000, resourceType: 'Fetch', responseSample: '{"ok":true,"sessions":[]}' }),
      n({ url: 'https://shop.example/graphql', method: 'POST', contentType: 'application/json', status: 200, bodyBytes: 4000, resourceType: 'Fetch', requestHeaders: { 'content-type': 'application/json', 'x-csrf-token': 'abc', accept: '*/*' }, auth: true, postData: '{"query":"q","variables":{"term":"red shoes"}}', responseSample: '{"data":{"items":[{"title":"Crimson Runner"},{"title":"Ruby Loafer"}]}}' }),
      n({ url: 'https://cdn.example/assets/app.js', contentType: 'application/javascript', status: 200, bodyBytes: 500000 }),
    ];
    const def = compileFromTrace(trace, net, { site: 'shop', name: 'search', description: 'Search', inputs: { term: 'red shoes' } });
    const f = def.func!;
    expect(f).toContain('const __tok0 = await tab.cookie("ct0")'); // the per-session CSRF token is re-read from the cookie at replay, not frozen
    expect(f).toContain('"x-csrf-token": __tok0'); // …and put back into the request headers
    expect(f).toContain('tab.fetchJson("https://shop.example/graphql", { method: "POST"'); // the endpoint that carried the data
    expect(f).toContain('body: JSON.stringify({"query":"q","variables":{"term":args.term}})'); // body parameterized on the declared input
    expect(def.warnings?.some((w) => /x-csrf-token/.test(w) && /cookie/.test(w))).toBe(true);
    expect(f).not.toContain('telemetry'); // the biggest response is not the answer; the one carrying the extracted values is
    expect(def.warnings?.some((w) => /matched 4 word/.test(w))).toBe(true);
    expect(def.warnings?.some((w) => /Authorization header/.test(w))).toBe(true);
    expect(() => new Function(`return (${f});`)).not.toThrow();
  });

  it('emits a signer hook for a computed signature header (not cookie-backed) instead of freezing it', () => {
    const trace: TraceEvent[] = [
      t({ kind: 'goto', url: 'https://xhs.example/explore' }),
      t({ kind: 'evaluate', code: 'x', result: '["Note A","Note B"]' }),
    ];
    const net = [
      n({ url: 'https://xhs.example/api/feed', method: 'GET', contentType: 'application/json', status: 200, bodyBytes: 3000, resourceType: 'Fetch', requestHeaders: { accept: '*/*', 'x-s': 'XYZsignature0123456789abcdef0123456789', 'x-t': '1717000000000' }, responseSample: '{"data":{"items":[{"title":"Note A"},{"title":"Note B"}]}}' }),
    ];
    const def = compileFromTrace(trace, net, { site: 'xhs', name: 'feed', description: 'Feed', inputs: {} });
    const f = def.func!;
    expect(f).toContain('SIGNER HOOK'); // the scaffold is emitted so the author recomputes the signature at replay
    expect(f).toContain('x-s'); // the header is named in the hook
    expect(f).not.toMatch(/"x-s":\s*"XYZ/); // …but its captured value is NOT frozen into headers
    expect(def.warnings?.some((w) => /x-s/.test(w) && /computed/.test(w) && /SIGNER HOOK/.test(w))).toBe(true);
    expect(() => new Function(`return (${f});`)).not.toThrow();
  });
});
