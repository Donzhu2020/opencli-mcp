import { describe, expect, it } from 'vitest';
import { discoverEndpoints } from '../src/recon/discover.js';
import { networkDetail, networkSummary } from '../src/api/network.js';
import type { RuntimePage } from '../src/backends/page-types.js';

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
