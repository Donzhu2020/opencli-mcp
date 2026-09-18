/**
 * Streamable HTTP MCP endpoint. One McpServer per MCP session; the runtime is shared. The same server listens either on
 * the local socket (no token — file permissions authorize) or on TCP with a bearer token for remote agents.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { timingSafeEqual } from 'node:crypto';
import type { Runtime } from '../runtime/runtime.js';
import { createMcpServer, type SessionServer } from '../mcp/server.js';

export type Listen = { path: string } | { port: number; host?: string };
export interface HttpServerHandle { endpoint: string; port?: number; host?: string; close(): Promise<void> }

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); if (!raw) return resolve(undefined); try { resolve(JSON.parse(raw)); } catch (err) { reject(err); } });
    req.on('error', reject);
  });
}

export async function startHttpServer(rt: Runtime, opts: { listen: Listen; token?: string; version: string }): Promise<HttpServerHandle> {
  const host = 'path' in opts.listen ? 'opencli-mcp.local' : (opts.listen.host ?? '127.0.0.1');
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; session: SessionServer }>();

  const authorized = (req: http.IncomingMessage, url: URL): boolean => {
    if (!opts.token) return true; // the local socket: whoever can open it is the user
    const h = req.headers.authorization ?? '';
    const bearer = h.startsWith('Bearer ') ? h.slice(7) : (url.searchParams.get('token') ?? '');
    const a = Buffer.from(bearer); const b = Buffer.from(opts.token);
    return a.length === b.length && timingSafeEqual(a, b);
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
      if (req.method !== 'POST') { res.writeHead(sessionId ? 404 : 400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: sessionId ? 'unknown mcp-session-id (host restarted?)' : 'missing mcp-session-id' })); return; }
      let body: unknown;
      try { body = await readBody(req); } catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid JSON body' })); return; }
      if (!isInitializeRequest(body)) { res.writeHead(sessionId ? 404 : 400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: sessionId ? 'unknown mcp-session-id; re-initialize' : 'expected an initialize request' })); return; }
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
      if (!sessions.has(newId)) { await session.close().catch(() => {}); }
    } catch (err) {
      rt.emit('log', `http error: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  const listen = opts.listen;
  const close = async () => { for (const s of sessions.values()) { await s.transport.close().catch(() => {}); await s.session.close().catch(() => {}); } await new Promise<void>((r) => server.close(() => r())); };
  if ('path' in listen) {
    if (process.platform !== 'win32') { fs.mkdirSync(path.dirname(listen.path), { recursive: true }); fs.rmSync(listen.path, { force: true }); } // a stale socket file from a crashed host
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(listen.path, () => resolve()); });
    if (process.platform !== 'win32') fs.chmodSync(listen.path, 0o600);
    return { endpoint: listen.path, close };
  }
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port, host, () => { const a = server.address(); resolve(typeof a === 'object' && a ? a.port : listen.port); });
  });
  return { endpoint: `http://${host}:${port}/mcp`, port, host, close };
}
