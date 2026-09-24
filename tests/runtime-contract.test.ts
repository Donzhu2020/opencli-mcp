import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ExtensionBridge } from '../src/host/bridge.js';
import { Runtime } from '../src/runtime/runtime.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { RuntimePage } from '../src/backends/page-types.js';
import type { NativeChannel } from '../src/host/native-messaging.js';

class FakeChannel extends EventEmitter {
  send(): void {}
}

function resultText(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.find((c) => c.type === 'text')?.text ?? '';
}

describe('runtime-advertised MCP contract', () => {
  it('changes tools and docs when the extension advertises or loses Network capture', async () => {
    const channel = new FakeChannel();
    const bridge = new ExtensionBridge(channel as unknown as NativeChannel);
    const rt = new Runtime({ bridge });
    await rt.init();
    const session = createMcpServer(rt, 'feature-contract');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await session.server.connect(serverTransport);
    const client = new Client({ name: 'feature-contract', version: '1' }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const initialTools = (await client.listTools()).tools;
      expect(initialTools.map((t) => t.name)).not.toContain('network_inspect');
      const actSchema = initialTools.find((t) => t.name === 'tab_act')?.inputSchema as { oneOf?: unknown[]; $defs?: Record<string, unknown> };
      expect(actSchema.oneOf).toHaveLength(8);
      expect(actSchema.$defs).toHaveProperty('Target');
      expect(JSON.stringify(actSchema).length).toBeLessThan(7_000);
      expect(resultText(await client.callTool({ name: 'docs_get', arguments: { name: 'capabilities/cdp' } }))).toContain('unknown_doc');
      expect(resultText(await client.callTool({ name: 'docs_get', arguments: { name: 'api-reference' } }))).not.toContain('  network: {');
      channel.emit('message', { type: 'hello', extensionVersion: 'test', features: ['cdp', 'network'] });
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('network_inspect');
      expect(resultText(await client.callTool({ name: 'doctor', arguments: {} }))).toContain('"network"');
      expect(resultText(await client.callTool({ name: 'docs_get', arguments: { name: 'capabilities/cdp' } }))).toContain('Chrome DevTools Protocol');
      expect(resultText(await client.callTool({ name: 'docs_get', arguments: { name: 'api-reference' } }))).toContain('  network: {');
      channel.emit('close');
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('network_inspect');
    } finally {
      await session.close();
      await client.close().catch(() => {});
      await rt.shutdown();
    }
  });
});

it('carries observation, read, and action evidence through MCP-only calls', async () => {
  const rt = new Runtime();
  const state = rt.session('evidence');
  let aria = '- main [ref=e1]\n  - button "Old" [ref=e2]\n  - link "Help" [ref=e3]';
  let captures = 0;
  vi.spyOn(rt, 'backend').mockReturnValue('extension');
  vi.spyOn(rt, 'hasFeature').mockReturnValue(true);
  const page = {
    getCurrentUrl: async () => 'https://example.test/',
    evaluate: async () => 'Example',
    pageCall: async (fn: string, args: Record<string, unknown>) => fn === 'aria' ? aria : fn === 'readText' ? args.readId ? { readId: 'capture-1', text: ' document', chars: 9, start: 5, complete: true } : { readId: 'capture-1', text: 'Hello', chars: 5, start: 0, nextStart: 5, complete: false, reason: 'budget' } : null,
    readNetworkCapture: async () => captures < 2 ? [{ requestId: `r${++captures}`, url: `https://example.test/${captures}`, method: 'GET', done: true }] : [],
    act: async () => ({ ok: true, kind: 'click', ref: 'e1', matches_n: 1, method: 'cdp', hit: 'target' }),
  } as unknown as RuntimePage;
  state.pages.set('page-1', page);
  const session = createMcpServer(rt, 'evidence');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  const client = new Client({ name: 'evidence', version: '1' }, { capabilities: {} });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse(resultText(await client.callTool({ name, arguments: { tab: 'page-1', ...args } }))) as Record<string, any>;
  try {
    const first = await call('tab_observe', {});
    aria = '- main [ref=e1]\n  - button "New" [ref=e2]\n  - link "Help" [ref=e3]';
    const second = await call('tab_observe', { since: first.snapshotId });
    expect(second).toMatchObject({ diff: true, changed: { changed: 1 } });
    expect(second.snapshotId).not.toBe(first.snapshotId);
    const stale = await call('tab_observe', { since: first.snapshotId });
    expect(stale.diff).toBeUndefined();
    expect(stale.state).toContain('New');
    const read = await call('tab_read', {});
    expect(await call('tab_read', { readId: read.readId, start: read.nextStart })).toMatchObject({ text: ' document', complete: true });
    const action = await call('tab_act', { action: 'click', target: { ref: 'e1' } });
    expect(action).toMatchObject({ delivery: 'received', controlState: 'unverified', network: { afterSequence: 1, cursor: 2 } });
    expect(await call('network_inspect', { afterSequence: action.network.afterSequence })).toMatchObject({ entries: [expect.objectContaining({ seq: 2 })] });
  } finally {
    await session.close();
    await client.close().catch(() => {});
    await rt.shutdown();
  }
});
