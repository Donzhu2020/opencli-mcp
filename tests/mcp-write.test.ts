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
  const drafts: string[] = [];
  const define = async (name: string, overrides: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: 'tools_define', arguments: { site, name, description: 'test write', access: 'write', func: 'async () => ({ done: true })', ...overrides } });
    const data = body(result);
    if (typeof data.draftId === 'string') drafts.push(data.draftId);
    return { result, data };
  };
  const tryDraft = async (draftId: string, args: Record<string, unknown> = {}, expect: Record<string, unknown> = { path: 'value.done', equals: true }) => body(await client.callTool({ name: 'tools_try', arguments: { draftId, args, expect } }));
  const activate = async (draftId: string) => body(await client.callTool({ name: 'tools_activate', arguments: { draftId } }));
  const cleanup = async () => {
    for (const draftId of drafts) await client.callTool({ name: 'tools_discard', arguments: { draftId } }).catch(() => {});
    try { await client.callTool({ name: 'js', arguments: { code: `await tools.remove('${site}', 'poke')` } }); } catch { /* ignore */ }
    await client.close().catch(() => {}); await rt.shutdown().catch(() => {});
  };
  return { client, site, define, tryDraft, activate, elicits: () => elicits, cleanup };
}

describe('adapter draft lifecycle and write commands', () => {
  it('runs writes through site_run, typed tools, and js without elicitation', async () => {
    const h = await harness();
    try {
      const { data } = await h.define('poke', { args: [{ name: 'x', required: false }] });
      expect(data).toMatchObject({ ok: true, status: 'draft' });
      expect(body(await h.client.callTool({ name: 'site_run', arguments: { site: h.site, command: 'poke', args: {} } }))).toMatchObject({ ok: false, error: { code: 'unknown_command' } });
      expect((await h.client.listTools()).tools.some((t) => t.name === `${h.site}_poke`)).toBe(false);
      expect(await h.tryDraft(data.draftId as string)).toMatchObject({ ok: true, verification: { passed: true } });
      expect(await h.activate(data.draftId as string)).toMatchObject({ ok: true, status: 'active' });
      expect(body(await h.client.callTool({ name: 'sites_search', arguments: {} }))).toMatchObject({ sites: expect.arrayContaining([expect.objectContaining({ site: h.site, commands: 1, write: 1 })]) });
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

  it('does not activate a failed or discarded draft', async () => {
    const h = await harness();
    try {
      const { data } = await h.define('poke');
      const draftId = data.draftId as string;
      expect(await h.tryDraft(draftId, {}, { path: 'value.done', equals: false })).toMatchObject({ verification: { passed: false } });
      expect(body(await h.client.callTool({ name: 'tools_activate', arguments: { draftId } }))).toMatchObject({ ok: false, error: { code: 'draft_not_verified' } });
      expect(body(await h.client.callTool({ name: 'tools_discard', arguments: { draftId } }))).toMatchObject({ ok: true, discarded: true });
      expect(body(await h.client.callTool({ name: 'tools_activate', arguments: { draftId } }))).toMatchObject({ ok: false, error: { code: 'unknown_draft' } });
    } finally { await h.cleanup(); }
  });
});
