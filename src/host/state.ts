/**
 * Host state on disk: where local launchers find the running host. Locally the host is reached over a unix socket
 * (a named pipe on Windows) — no port, no token: the socket's file permissions are the authorization, like Codex's
 * browser-service. A TCP endpoint with a bearer token exists only when `config.remote` asks for one (cloud agents).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Agent, fetch as undiciFetch } from 'undici';

/** The one place state lives: token, extension key, host state, config, agent-defined tools. */
export const OPENCLI_MCP_DIR = path.join(os.homedir(), '.opencli-mcp');
export const RUN_DIR = path.join(OPENCLI_MCP_DIR, 'run');
export const HOST_STATE_FILE = path.join(RUN_DIR, 'host.json');
export const TOKEN_FILE = path.join(OPENCLI_MCP_DIR, 'token');
export const CONFIG_FILE = path.join(OPENCLI_MCP_DIR, 'config.json');
/** The local MCP endpoint: a unix socket, or a named pipe on Windows. */
export const SOCKET_PATH = process.platform === 'win32' ? `\\\\.\\pipe\\opencli-mcp-${os.userInfo().username}` : path.join(RUN_DIR, 'host.sock');
export const DEFAULT_REMOTE_PORT = 19850;

export interface HostState { pid: number; socket: string; remote?: { host: string; port: number; token: string }; startedAt: number; extensionVersion?: string | null; contextId?: string; version: string }
export interface Config { cursor?: boolean; sites?: string[]; sitesWrite?: string[]; remote?: { port?: number; host?: string }; policy?: { askNewOrigins?: boolean; confirmWrites?: boolean; allowedHosts?: string[]; blockedHosts?: string[] } }

/** fetch over the host's local socket; the URL's host part is nominal. */
export function socketFetch(socketPath: string): (input: string | URL, init?: RequestInit) => Promise<Response> {
  const dispatcher = new Agent({ connect: { socketPath } });
  return (input, init) => undiciFetch(String(input), { ...(init as Record<string, unknown>), dispatcher } as never) as unknown as Promise<Response>;
}
export const LOCAL_MCP_URL = 'http://opencli-mcp.local/mcp';

export function readConfig(): Config {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Config; } catch { return {}; }
}

export function loadOrCreateToken(): string {
  try { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); if (t.length >= 32) return t; } catch { /* create */ }
  fs.mkdirSync(OPENCLI_MCP_DIR, { recursive: true });
  const t = randomBytes(24).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}

export function writeHostState(s: HostState): void {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(HOST_STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}
export function clearHostState(pid: number): void {
  try { const s = readHostState(); if (s && s.pid === pid) fs.rmSync(HOST_STATE_FILE); } catch { /* ignore */ }
}
export function readHostState(): HostState | null {
  try { return JSON.parse(fs.readFileSync(HOST_STATE_FILE, 'utf8')) as HostState; } catch { return null; }
}

export async function hostHealth(s: HostState | null, timeoutMs = 1500): Promise<{ ok: boolean; backend?: string; sessions?: number; extensionConnected?: boolean; error?: string }> {
  if (!s) return { ok: false, error: 'no host state file' };
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await socketFetch(s.socket)('http://opencli-mcp.local/health', { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j = await res.json() as { backend: string; sessions: number; extensionConnected: boolean };
    return { ok: true, ...j };
  } catch (err) { return { ok: false, error: (err as Error).message }; }
}
