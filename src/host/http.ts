/**
 * Streamable HTTP MCP endpoint on loopback, bearer-token authenticated. One McpServer per MCP
 * session; the runtime is shared. Local launchers and cloud agents (via a tunnel) use the same endpoint.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Runtime } from '../runtime/runtime.js';
import { createMcpServer, type SessionServer } from '../mcp/server.js';

export interface HttpServerHandle { port: number; host: string; close(): Promise<void> }

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); if (!raw) return resolve(undefined); try { resolve(JSON.parse(raw)); } catch (err) { reject(err); } });
    req.on('error', reject);
  });
}

export async function startHttpServer(rt: Runtime, opts: { port: number; host?: string; token: string; version: string; allowNoAuth?: boolean }): Promise<HttpServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; session: SessionServer }>();

  const authorized = (req: http.IncomingMessage, url: URL): boolean => {
    if (opts.allowNoAuth) return true;
    const h = req.headers.authorization ?? '';
    const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
    return bearer === opts.token || url.searchParams.get('token') === opts.token;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    try {
      if (!authorized(req, url)) { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' })); return; }
      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, backend: rt.backend(), sessions: rt.sessions.size, extensionConnected: Boolean(rt.bridge?.connected), version: opts.version, uptimeMs: Date.now() - rt.startedAt }));
        return;
      }
      if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }
      const sid = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(sid) ? sid[0] : sid;
      if (sessionId && sessions.has(sessionId)) {
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        await sessions.get(sessionId)!.transport.handleRequest(req, res, body);
        return;
      }
      if (req.method !== 'POST') { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing or unknown mcp-session-id' })); return; }
      const body = await readBody(req);
      const newId = randomUUID();
      const session = createMcpServer(rt, newId, { version: opts.version });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newId,
        onsessioninitialized: (id) => { sessions.set(id, { transport, session }); },
        onsessionclosed: async (id) => { const s = sessions.get(id); sessions.delete(id); await s?.session.close(); },
      });
      transport.onclose = () => { if (sessions.has(newId)) { sessions.delete(newId); void session.close(); } };
      await session.server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      rt.emit('log', `http error: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => { const a = server.address(); resolve(typeof a === 'object' && a ? a.port : opts.port); });
  });
  return {
    port, host,
    close: async () => { for (const s of sessions.values()) { await s.transport.close().catch(() => {}); await s.session.close().catch(() => {}); } await new Promise<void>((r) => server.close(() => r())); },
  };
}
