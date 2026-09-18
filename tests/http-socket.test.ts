import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Runtime } from '../src/runtime/runtime.js';
import { startHttpServer } from '../src/host/http.js';
import { socketFetch, hostHealth, LOCAL_MCP_URL } from '../src/host/state.js';

describe('local endpoint is a socket, not a port', () => {
  it('serves health and MCP over a unix socket without a token, and refuses a TCP listener without one', async () => {
    if (process.platform === 'win32') return;
    const rt = new Runtime({ log: () => {} });
    await rt.init();
    const sock = join(mkdtempSync(join(tmpdir(), 'opencli-mcp-sock-')), 'host.sock');
    const h = await startHttpServer(rt, { listen: { path: sock }, version: 'test' });
    try {
      expect(h.endpoint).toBe(sock);
      const health = await hostHealth({ pid: process.pid, socket: sock, startedAt: Date.now(), version: 'test' });
      expect(health.ok).toBe(true);
      const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(LOCAL_MCP_URL), { fetch: socketFetch(sock) as unknown as typeof fetch }));
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('doctor');
      await client.close();
      // a TCP listener with a token rejects unauthenticated callers
      const tcp = await startHttpServer(rt, { listen: { port: 0 }, token: 'secret', version: 'test' });
      try {
        const res = await fetch(`http://127.0.0.1:${tcp.port}/health`);
        expect(res.status).toBe(401);
        const ok = await fetch(`http://127.0.0.1:${tcp.port}/health`, { headers: { authorization: 'Bearer secret' } });
        expect(ok.status).toBe(200);
      } finally { await tcp.close(); }
    } finally { await h.close(); await rt.shutdown(); }
  });
});
