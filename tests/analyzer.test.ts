import { describe, expect, it } from 'vitest';
import { JsAnalyzer, maybeUrl, decodeString, EXPR } from '../src/recon/analyzer.js';

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
    expect(r.secrets.map((s) => s.kind)).toEqual(expect.arrayContaining(['keyed_secret', 'aws_access_key']));
    for (const s of r.secrets) expect(s.preview).not.toContain('1234567890abcdef');
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
