/**
 * Run a site command (adapter) inside the opencli-mcp runtime.
 * Mirrors OpenCLI's executeCommand semantics (arg coercion, browser session, pre-navigation,
 * timeout, hooks) but obtains pages from our own runtime instead of a daemon.
 */
import type { CliCommand } from '@jackwener/opencli/registry';
import { executePipeline } from '@jackwener/opencli/pipeline';
import { toEnvelope } from '@jackwener/opencli/errors';
import { emitHook, type HookContext } from './hooks.js';
import { coerceArgs } from './schema.js';
import type { RuntimePage } from '../backends/page-types.js';

export interface PageProvider {
  getAdapterPage(site: string, opts: { siteSession: 'ephemeral' | 'persistent'; windowMode: 'foreground' | 'background'; navigateTo?: string }): Promise<RuntimePage>;
  browserAvailable(): boolean;
}

export interface CommandRunResult {
  ok: true;
  site: string;
  name: string;
  columns?: string[];
  rows?: unknown[];
  value?: unknown;
  elapsedMs: number;
}
export interface CommandRunError {
  ok: false;
  site: string;
  name: string;
  error: { code: string; message: string; hint?: string };
  elapsedMs: number;
}

export const DEFAULT_TIMEOUT_MS = 60_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`), { code: 'TIMEOUT' })), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

function urlHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname; } catch { return null; }
}

export async function runSiteCommand(
  provider: PageProvider,
  cmd: CliCommand,
  rawArgs: Record<string, unknown>,
  opts: { timeoutMs?: number; debug?: boolean; windowMode?: 'foreground' | 'background'; siteSession?: 'ephemeral' | 'persistent' } = {},
): Promise<CommandRunResult | CommandRunError> {
  const started = Date.now();
  const key = `${cmd.site}/${cmd.name}`;
  try {
    const declaresTimeout = cmd.args.some((a) => a.name === 'timeout');
    const { timeout, ...rest } = rawArgs;
    const userArgs = declaresTimeout ? rawArgs : rest;
    const args = coerceArgs(cmd.args, userArgs);
    cmd.validateArgs?.(args);
    const timeoutMs = typeof timeout === 'number' ? timeout * 1000 : (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const hookCtx: HookContext = { command: key, args, startedAt: started };
    await emitHook('onBeforeExecute', hookCtx);

    let result: unknown;
    if (!cmd.browser) {
      const run = cmd.func ? (cmd.func as (a: Record<string, unknown>, d?: boolean) => Promise<unknown>)(args, opts.debug) : executePipeline(null, cmd.pipeline ?? [], { args, debug: opts.debug });
      result = await withTimeout(run, timeoutMs, key);
    } else {
      if (!provider.browserAvailable()) {
        throw Object.assign(new Error(`${key} needs a logged-in browser, but no Chrome extension or CDP endpoint is connected`), { code: 'BROWSER_CONNECT', hint: 'Install the opencli-mcp extension (run `opencli-mcp doctor`), or set OPENCLI_CDP_ENDPOINT for a CDP-reachable browser.' });
      }
      const siteSession = opts.siteSession ?? cmd.siteSession ?? 'ephemeral';
      const windowMode = opts.windowMode ?? cmd.defaultWindowMode ?? 'background';
      const preNav = typeof cmd.navigateBefore === 'string' ? cmd.navigateBefore : undefined;
      const page = await provider.getAdapterPage(cmd.site, { siteSession, windowMode, navigateTo: preNav });
      if (preNav) {
        // OpenCLI semantics: always pre-navigate, except a persistent site session already on the domain when the target is the domain root
        const current = await page.getCurrentUrl?.().catch(() => null);
        const want = urlHost(preNav);
        let isRoot = false; try { const u = new URL(preNav); isRoot = (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash; } catch { /* not root */ }
        const sameDomain = Boolean(current && want && (urlHost(current) === want || urlHost(current)?.endsWith(`.${want.replace(/^www\./, '')}`)));
        if (!(siteSession === 'persistent' && isRoot && sameDomain)) await page.goto(preNav);
      }
      const run = cmd.func ? (cmd.func as (p: RuntimePage, a: Record<string, unknown>, d?: boolean) => Promise<unknown>)(page, args, opts.debug) : executePipeline(page, cmd.pipeline ?? [], { args, debug: opts.debug });
      result = await withTimeout(run, timeoutMs, key);
    }
    hookCtx.finishedAt = Date.now();
    await emitHook('onAfterExecute', hookCtx, result);
    const elapsedMs = Date.now() - started;
    if (Array.isArray(result)) return { ok: true, site: cmd.site, name: cmd.name, columns: cmd.columns, rows: result, elapsedMs };
    if (result && typeof result === 'object' && cmd.columns) return { ok: true, site: cmd.site, name: cmd.name, columns: cmd.columns, rows: [result], elapsedMs };
    return { ok: true, site: cmd.site, name: cmd.name, value: result, elapsedMs };
  } catch (err) {
    const env = toEnvelope(err) as { code?: string; message?: string; hint?: string };
    const anyErr = err as { code?: string; hint?: string; message?: string };
    return {
      ok: false, site: cmd.site, name: cmd.name, elapsedMs: Date.now() - started,
      error: { code: String(env.code ?? anyErr.code ?? 'COMMAND_EXEC'), message: String(env.message ?? anyErr.message ?? err), hint: env.hint ?? anyErr.hint },
    };
  }
}
