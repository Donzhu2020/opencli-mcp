import { describe, expect, it } from 'vitest';
import { JsAnalyzer, maybeUrl, decodeString, EXPR } from '../src/recon/analyzer.js';
import { discoverEndpoints } from '../src/recon/discover.js';
import { networkDetail, networkSummary } from '../src/api/network.js';
import type { RuntimePage } from '../src/backends/page-types.js';

describe('JsAnalyzer (jsluice port)', () => {
  it('finds fetch/xhr/jquery/axios/location URLs and resolves concatenation', async () => {
    const a = await JsAnalyzer.create();
    const r = a.analyze(`
      const base = "/api/v2";
      fetch("/api/v2/items?page=" + page + "&sort=new", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: query, limit: 20 }) });
      const x = new XMLHttpRequest(); x.open("GET", "https://api.example.com/users/" + id);
      $.ajax({ url: "/legacy/search", type: "post", data: { term: t } });
      axios.get("/v1/profile", { params: { full: 1 } });
      api.post("/v1/comments", { text });
      document.location = "/login?redirect=" + next + "&method=oauth";
      const ws = new WebSocket("wss://stream.example.com/feed");
      const cfg = { apiKey: "AUTH_1234567890abcdef", baseURL: "https://api.example.com" };
      const t = "AKIAIOSFODNN7EXAMPLE";
    `, { filename: 'bundle.js' });
    const byType = Object.fromEntries(r.urls.map((u) => [u.type + ':' + u.url, u]));
    expect(byType[`fetch:/api/v2/items?page=${EXPR}&sort=new`]).toMatchObject({ method: 'POST', bodyParams: ['limit', 'q'], kind: 'api' });
    expect(byType[`fetch:/api/v2/items?page=${EXPR}&sort=new`].queryParams).toEqual(['page', 'sort']);
    expect(byType[`xhr:https://api.example.com/users/${EXPR}`]).toMatchObject({ method: 'GET' });
    expect(byType['jquery:/legacy/search']).toMatchObject({ method: 'POST', bodyParams: ['term'] });
    expect(byType['axios:/v1/profile']).toMatchObject({ method: 'GET', queryParams: ['full'] });
    expect(byType['httpClient:/v1/comments']).toMatchObject({ method: 'POST', bodyParams: ['text'] });
    expect(byType[`locationAssignment:/login?redirect=${EXPR}&method=oauth`].queryParams).toEqual(['method', 'redirect']);
    expect(byType['websocket:wss://stream.example.com/feed']).toBeTruthy();
    expect(r.urls.some((u) => u.url === 'https://api.example.com' && u.type === 'string')).toBe(true);
  });
  it('tolerates broken/minified input', async () => {
    const a = await JsAnalyzer.create();
    const r = a.analyze('function(){fetch("/api/ok");var y=');
    expect(r.urls.map((u) => u.url)).toContain('/api/ok');
    expect(r.parseErrors).toBe(true);
  });
  it('maybeUrl heuristics', () => {
    expect(maybeUrl('/api/x')).toBe(true);
    expect(maybeUrl('https://a.b/c')).toBe(true);
    expect(maybeUrl('hello world')).toBe(false);
    expect(maybeUrl('a.b')).toBe(false);
    expect(maybeUrl('file.json')).toBe(true);
    expect(decodeString('"a\\u0026b\\/c"')).toBe('a&b/c');
  });
});

describe('agent network evidence', () => {
  it('keeps the request list compact and pages only the selected body', () => {
    const entry = { seq: 7, requestId: 'request-7', url: 'https://site.test/api/items', method: 'POST', responseStatus: 201, responseContentType: 'application/json', responsePreview: 'x'.repeat(30_000), responseBodyFullSize: 30_000 };
    const summary = networkSummary(entry);
    expect(summary).toMatchObject({ seq: 7, status: 201, contentType: 'application/json' });
    expect(JSON.stringify(summary)).not.toContain('xxx');
    const first = networkDetail(entry, { maxChars: 8_000 }).body as { text: string; nextStart: number };
    expect(first.text).toHaveLength(8_000);
    expect(first.nextStart).toBe(8_000);
    const last = networkDetail(entry, { start: first.nextStart, maxChars: 100_000 }).body as { text: string; nextStart?: number };
    expect(last.text).toHaveLength(22_000);
    expect(last.nextStart).toBeUndefined();
  });

  it('merges a relative static endpoint with the captured absolute URL, without double counting Performance', async () => {
    const captured = { requestId: 'r1', url: 'https://site.test/api/items?limit=10', method: 'POST', responseStatus: 201, responseContentType: 'application/json' };
    const page = {
      getCurrentUrl: async () => 'https://site.test/feed',
      evaluate: async () => [{ src: '', inline: 'fetch("/api/items?limit=10", { method: "POST", body: JSON.stringify({ q: query }) });' }],
      readNetworkCapture: async () => [captured],
      networkRequests: async () => [{ name: captured.url, responseStatus: 201, responseContentType: 'application/json' }],
    } as unknown as RuntimePage;
    const dynamic = await discoverEndpoints(page);
    expect(dynamic.scripts).toEqual([]);
    expect(dynamic.networkEntries).toBe(1);
    expect(dynamic.endpoints).toEqual([expect.objectContaining({ evidence: 'network', network: expect.objectContaining({ status: 201, requestId: 'r1', count: 1 }) })]);
    const merged = await discoverEndpoints(page, { includeStatic: true });
    expect(merged.networkEntries).toBe(1);
    expect(merged.endpoints).toEqual(expect.arrayContaining([expect.objectContaining({ evidence: 'network+static', network: expect.objectContaining({ status: 201, count: 1 }), sources: expect.arrayContaining([expect.objectContaining({ script: 'inline#1' })]) })]));
  });

  it('joins a static path template with a captured string identifier', async () => {
    const page = {
      getCurrentUrl: async () => 'https://site.test/users',
      evaluate: async () => [{ src: '', inline: 'async function loadUser(username) { return fetch("/api/users/" + username, { method: "GET" }); }' }],
      readNetworkCapture: async () => [{ requestId: 'user-1', url: 'https://site.test/api/users/alice', method: 'GET', responseStatus: 200, responseContentType: 'application/json' }],
      networkRequests: async () => [],
    } as unknown as RuntimePage;
    const result = await discoverEndpoints(page, { includeStatic: true });
    expect(result.endpoints.filter((entry) => entry.url.includes('/api/users/'))).toEqual([expect.objectContaining({ evidence: 'network+static', network: expect.objectContaining({ requestId: 'user-1' }) })]);
  });
});
