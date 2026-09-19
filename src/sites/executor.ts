/**
 * Run a site command (adapter) inside the opencli-mcp runtime.
 * Mirrors OpenCLI's executeCommand semantics (arg coercion, browser session, pre-navigation,
 * timeout) but obtains pages from our own runtime instead of a daemon.
 */
import type { CliCommand } from '@jackwener/opencli/registry';
import { executePipeline } from '@jackwener/opencli/pipeline';
import { toEnvelope } from '@jackwener/opencli/errors';
import { coerceArgs, restoreArgNames } from './schema.js';
import { ActionError, normalizeErrorCode } from '../api/errors.js';
import type { RuntimePage } from '../backends/page-types.js';

export interface PageProvider {
  getAdapterPage(site: string, opts: { siteSession: 'ephemeral' | 'persistent'; windowMode: 'foreground' | 'background'; navigateTo?: string }): Promise<RuntimePage>;
  browserAvailable(): boolean;
  /** The object model for an agent-defined (frozen) tool: the same `tab`/`sites`/`recon` the agent explored with, bound to the adapter page. */
  toolContext(page: RuntimePage, site: string): Promise<Record<string, unknown>>;
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
  error: { code: string; message: string; hint?: string; /** for compiled flows: which step failed, the page state then, and the expectation that did not hold */ details?: { step?: number; label?: string; state?: string; expect?: unknown; failed?: string[] } };
  elapsedMs: number;
}

export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Resolve the wall-clock for a site command. Timeout is runtime-managed (the CLI `timeout` arg is not exposed to the
 * agent). Precedence: explicit value (js escape hatch) → the command's own declared default (logins/deep-research
 * legitimately need minutes) → the runtime default. The client can always cancel via MCP.
 */
export function resolveTimeoutMs(cmdArgs: CliCommand['args'], explicit: unknown, optsTimeoutMs?: number): number {
  const declared = cmdArgs.find((a) => a.name === 'timeout')?.default;
  if (typeof explicit === 'number') return explicit * 1000;
  if (typeof declared === 'number') return declared * 1000;
  return optsTimeoutMs ?? DEFAULT_TIMEOUT_MS;
}

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
    // Agents call with the projected (snake_case) arg names; map them back to the adapter's original CLI names before coercion.
    rawArgs = restoreArgNames(cmd.args, rawArgs);
    const declaresTimeout = cmd.args.some((a) => a.name === 'timeout');
    const { timeout, ...rest } = rawArgs;
    const userArgs = declaresTimeout ? rawArgs : rest;
    const args = coerceArgs(cmd.args, userArgs);
    cmd.validateArgs?.(args);
    const timeoutMs = resolveTimeoutMs(cmd.args, timeout, opts.timeoutMs);

    let result: unknown;
    if (!cmd.browser) {
      const run = cmd.func ? (cmd.func as (a: Record<string, unknown>, d?: boolean) => Promise<unknown>)(args, opts.debug) : executePipeline(null, cmd.pipeline ?? [], { args, debug: opts.debug });
      result = await withTimeout(run, timeoutMs, key);
    } else {
      if (!provider.browserAvailable()) {
        throw Object.assign(new Error(`${key} needs a logged-in browser, but the Chrome extension is not connected`), { code: 'BROWSER_CONNECT', hint: 'Install the opencli-mcp extension and keep Chrome running (run `opencli-mcp doctor`).' });
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
      // frozen (agent-defined) tools receive the exploration object model; corpus adapters keep OpenCLI's (page, args)
      const run = cmd.func
        ? ((cmd as { source?: string }).source === 'defined'
          ? (cmd.func as unknown as (ctx: Record<string, unknown>) => Promise<unknown>)({ ...(await provider.toolContext(page, cmd.site)), args, debug: opts.debug })
          : (cmd.func as (p: RuntimePage, a: Record<string, unknown>, d?: boolean) => Promise<unknown>)(page, args, opts.debug))
        : executePipeline(page, cmd.pipeline ?? [], { args, debug: opts.debug });
      result = await withTimeout(run, timeoutMs, key);
    }
    const elapsedMs = Date.now() - started;
    if (Array.isArray(result)) return { ok: true, site: cmd.site, name: cmd.name, columns: cmd.columns, rows: result, elapsedMs };
    if (result && typeof result === 'object' && cmd.columns) return { ok: true, site: cmd.site, name: cmd.name, columns: cmd.columns, rows: [result], elapsedMs };
    return { ok: true, site: cmd.site, name: cmd.name, value: result, elapsedMs };
  } catch (err) {
    // toEnvelope returns { ok, error: { code, message, help } } — read the nested shape (the old top-level read was always undefined, dropping OpenCLI codes and hints)
    const env = (toEnvelope(err) as { error?: { code?: string; message?: string; help?: string } }).error ?? {};
    const anyErr = err as { code?: string; hint?: string; message?: string; step?: number; label?: string; state?: string; expect?: unknown; failed?: string[]; extra?: { expect?: unknown; state?: string; failed?: string[] } };
    const details = anyErr.step !== undefined ? { step: anyErr.step, label: anyErr.label, state: anyErr.state, ...(anyErr.expect !== undefined && { expect: anyErr.expect, failed: anyErr.failed }) } : anyErr.extra?.expect !== undefined ? { expect: anyErr.extra.expect, failed: anyErr.extra.failed, state: anyErr.extra.state } : undefined;
    // Frozen tools throw ActionError in the object-model vocabulary — keep that code verbatim; otherwise normalize the
    // corpus/adapter code (SCREAMING_SNAKE / CamelCase) to the same lowercase families, so a model branches on one vocabulary.
    const rawCode = err instanceof ActionError ? err.code : (env.code ?? anyErr.code ?? 'COMMAND_EXEC');
    return {
      ok: false, site: cmd.site, name: cmd.name, elapsedMs: Date.now() - started,
      error: { code: normalizeErrorCode(String(rawCode)), message: String(env.message ?? anyErr.message ?? err), hint: env.help ?? anyErr.hint, ...(details && { details }) },
    };
  }
}
