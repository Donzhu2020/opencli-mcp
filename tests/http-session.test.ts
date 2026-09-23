import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Runtime } from '../src/runtime/runtime.js';
import { SESSION_HEADER, startHttpServer } from '../src/host/http.js';

describe('HTTP client sessions', () => {
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const close of open.splice(0).reverse()) await close().catch(() => {}); });

  it('keeps two MCP clients in separate runtime sessions and cleans up only the departing one', async () => {
    const rt = new Runtime();
    await rt.init();
    const host = await startHttpServer(rt, { port: 0, token: 'test', version: '0.0.12', allowNoAuth: true });
    open.push(() => host.close());
    const missing = await fetch(`http://${host.host}:${host.port}/mcp`, { method: 'POST' });
    expect(missing.status).toBe(400);
    const connect = async (id: string) => {
      const client = new Client({ name: id, version: '1' }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(`http://${host.host}:${host.port}/mcp`), { requestInit: { headers: { [SESSION_HEADER]: id } } });
      await client.connect(transport);
      open.push(() => client.close());
      await client.callTool({ name: 'doctor', arguments: {} });
      return client;
    };
    const first = await connect('client-one');
    await connect('client-two');
    expect(rt.sessions.has('client-one')).toBe(true);
    expect(rt.sessions.has('client-two')).toBe(true);
    await first.close();
    const response = await fetch(`http://${host.host}:${host.port}/session`, { method: 'DELETE', headers: { [SESSION_HEADER]: 'client-one' } });
    expect(response.status).toBe(204);
    expect(rt.sessions.has('client-one')).toBe(false);
    expect(rt.sessions.has('client-two')).toBe(true);
  });
});
