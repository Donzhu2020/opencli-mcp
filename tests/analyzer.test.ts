import { describe, expect, it } from 'vitest';
import { discoverEndpoints } from '../src/recon/discover.js';
import type { RuntimePage } from '../src/backends/page-types.js';

describe('agent network evidence', () => {
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
});
