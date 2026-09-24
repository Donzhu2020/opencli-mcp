import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ExtensionBridge } from '../src/host/bridge.js';
import { Runtime } from '../src/runtime/runtime.js';
import { createMcpServer } from '../src/mcp/server.js';
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
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('network_inspect');
      expect(resultText(await client.callTool({ name: 'docs_get', arguments: { name: 'capabilities/cdp' } }))).toContain('unknown_doc');
      channel.emit('message', { type: 'hello', extensionVersion: 'test', features: ['cdp', 'network'] });
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('network_inspect');
      expect(resultText(await client.callTool({ name: 'doctor', arguments: {} }))).toContain('"network"');
      expect(resultText(await client.callTool({ name: 'docs_get', arguments: { name: 'capabilities/cdp' } }))).toContain('Chrome DevTools Protocol');
      channel.emit('close');
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('network_inspect');
    } finally {
      await session.close();
      await client.close().catch(() => {});
      await rt.shutdown();
    }
  });
});
