/**
 * MRTR (multi-round-trip) confirmations: a write command must ask the user via an input_required round;
 * the client fulfils it through its elicitation handler and the call resumes. Covers approve, decline,
 * and policy-off (no prompt). This is the D1 regression guard — elicitInput throwing under 2026-07-28
 * used to make native confirmations silently degrade.
 */
import { describe, it, expect } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { Runtime } from '../src/runtime/runtime.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { PolicyConfig } from '../src/runtime/policy.js';

type ElicitResult = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> };

async function harness(policy: PolicyConfig, responder: (n: number) => ElicitResult) {
  const rt = new Runtime({ policy, log: () => {} });
  await rt.init();
  const session = createMcpServer(rt, `test-${Math.random().toString(36).slice(2)}`, { persistent: true });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverT);
  let elicits = 0;
  const client = new Client({ name: 'test', version: '0' }, { capabilities: { elicitation: {} } });
  client.setRequestHandler('elicitation/create', async () => { elicits += 1; return responder(elicits); });
  await client.connect(clientT);
  const site = `ctest${Math.random().toString(36).slice(2)}`;
  await client.callTool({ name: 'tools_define', arguments: { site, name: 'poke', description: 'test write', access: 'write', strategy: 'public', args: [{ name: 'x', required: false }], func: 'async () => ({ done: true })' } });
  const cleanup = async () => { try { await client.callTool({ name: 'js', arguments: { code: `tools.remove('${site}', 'poke')` } }); } catch { /* ignore */ } await client.close().catch(() => {}); await rt.shutdown().catch(() => {}); };
  return { client, site, elicits: () => elicits, cleanup };
}

describe('MRTR confirmations (D1)', () => {
  it('asks the user and runs the write when approved', async () => {
    const h = await harness({ confirmWrites: true }, () => ({ action: 'accept', content: { approve: true } }));
    try {
      const r = await h.client.callTool({ name: 'site_run', arguments: { site: h.site, command: 'poke', args: {} } });
      expect(r.isError).toBeFalsy();
      expect(h.elicits()).toBe(1); // the approval prompt actually fired
      expect(r.structuredContent ?? {}).toMatchObject({ ok: true, value: { done: true } });
    } finally { await h.cleanup(); }
  });

  it('reports user_declined when the user rejects', async () => {
    const h = await harness({ confirmWrites: true }, () => ({ action: 'decline' }));
    try {
      const r = await h.client.callTool({ name: 'site_run', arguments: { site: h.site, command: 'poke', args: {} } });
      expect(h.elicits()).toBe(1);
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.structuredContent ?? r.content)).toContain('user_declined');
    } finally { await h.cleanup(); }
  });

  it('does not prompt when confirmWrites is off', async () => {
    const h = await harness({ confirmWrites: false }, () => ({ action: 'accept', content: { approve: true } }));
    try {
      const r = await h.client.callTool({ name: 'site_run', arguments: { site: h.site, command: 'poke', args: {} } });
      expect(r.isError).toBeFalsy();
      expect(h.elicits()).toBe(0); // no approval round when policy is off
    } finally { await h.cleanup(); }
  });
});
