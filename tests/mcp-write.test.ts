import { describe, it, expect } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { Runtime } from '../src/runtime/runtime.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { RuntimePage } from '../src/backends/page-types.js';

/** Parse the tool result's text content (the one result envelope: {ok,…} | {ok:false,error}). */
function body(r: { content?: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const t = (r.content ?? []).find((c) => c.type === 'text')?.text ?? '{}';
  try { return JSON.parse(t) as Record<string, unknown>; } catch { return { raw: t }; }
}

async function harness() {
  const rt = new Runtime({ log: () => {} });
  await rt.init();
  // Adapter execution always requires a browser page; this focused MCP test supplies one.
  rt.browserAvailable = () => true;
  rt.getAdapterPage = async () => ({}) as RuntimePage;
  rt.toolContext = async () => ({ tab: {}, sites: {}, recon: {} });
  const session = createMcpServer(rt, `test-${Math.random().toString(36).slice(2)}`, { persistent: true });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverT);
  let elicits = 0;
  const client = new Client({ name: 'test', version: '0' }, { capabilities: { elicitation: {} } });
  client.setRequestHandler('elicitation/create', async () => { elicits += 1; throw new Error('Unexpected approval request'); });
  await client.connect(clientT);
  const site = `ctest${Math.random().toString(36).slice(2)}`;
  await client.callTool({ name: 'tools_define', arguments: { site, name: 'poke', description: 'test write', access: 'write', args: [{ name: 'x', required: false }], func: 'async () => ({ done: true })' } });
  const cleanup = async () => { try { await client.callTool({ name: 'js', arguments: { code: `tools.remove('${site}', 'poke'); tools.remove('${site}', 'need')` } }); } catch { /* ignore */ } await client.close().catch(() => {}); await rt.shutdown().catch(() => {}); };
  return { client, site, elicits: () => elicits, cleanup };
}

describe('write commands execute directly', () => {
  it('exposes explicit tab discovery, release, and close', async () => {
    const h = await harness();
    try {
      const names = (await h.client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('tab_list');
      expect(names).toContain('tab_close');
      expect(names).toContain('tab_release');
      const unavailable = await h.client.callTool({ name: 'tab_list', arguments: { user: true } });
      expect(body(unavailable)).toMatchObject({ ok: false, error: { code: 'browser_unavailable' } });
    } finally { await h.cleanup(); }
  });

  it('runs writes through site_run, typed tools, and js without elicitation', async () => {
    const h = await harness();
    try {
      const direct = await h.client.callTool({ name: 'site_run', arguments: { site: h.site, command: 'poke', args: {} } });
      expect(body(direct)).toMatchObject({ ok: true, value: { done: true } });
      await h.client.callTool({ name: 'js', arguments: { code: `await sites.enable('${h.site}', { write: true })` } });
      const tools = await h.client.listTools();
      expect(tools.tools.some(t => t.name === `${h.site}_poke`)).toBe(true);
      const typed = await h.client.callTool({ name: `${h.site}_poke`, arguments: {} });
      expect(body(typed)).toMatchObject({ ok: true, value: { done: true } });
      const js = await h.client.callTool({ name: 'js', arguments: { code: `await sites.${h.site}.poke({})` } });
      expect(body(js)).toMatchObject({ ok: true, value: { done: true } });
      expect(h.elicits()).toBe(0);
    } finally { await h.cleanup(); }
  });

  it('still rejects invalid write arguments', async () => {
    const h = await harness();
    try {
      await h.client.callTool({ name: 'tools_define', arguments: { site: h.site, name: 'need', description: 'needs text', access: 'write', args: [{ name: 'text', required: true }], func: 'async () => { throw new Error("must not execute"); }' } });
      const r = await h.client.callTool({ name: 'site_run', arguments: { site: h.site, command: 'need', args: {} } });
      expect(r.isError).toBe(true);
      expect(body(r)).toMatchObject({ ok: false, error: { code: 'invalid_args', details: { expected: [{ name: 'text' }] } } });
      expect(h.elicits()).toBe(0);
    } finally { await h.cleanup(); }
  });
});
