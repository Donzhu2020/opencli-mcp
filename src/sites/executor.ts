/**
 * Run an adapter: coerce args, provision the logged-in page (for browser adapters), build the object-model context
 * `{ args, tab, sites, recon, signal }`, call the adapter's `run`, and shape the result. One code path — no pipeline
 * engine, no CDP shadow page, no source branching.
 */
import { coerceArgs } from './schema.js';
import { ActionError } from '../api/errors.js';
import type { AdapterCommand } from './loader.js';
import type { RuntimePage } from '../backends/page-types.js';

export interface PageProvider {
  getAdapterPage(site: string, opts: { siteSession: 'ephemeral' | 'persistent'; windowMode: 'foreground' | 'background'; navigateTo?: string }): Promise<RuntimePage>;
  browserAvailable(): boolean;
  /** The object model bound to a page: the same `tab`/`sites`/`recon` an agent uses in `js`. */
  toolContext(page: RuntimePage, site: string): Promise<Record<string, unknown>>;
}

export interface CommandRunResult { ok: true; site: string; name: string; rows?: unknown[]; value?: unknown; nextCursor?: string; elapsedMs: number }
export interface CommandRunError { ok: false; site: string; name: string; error: { code: string; message: string; hint?: string; details?: Record<string, unknown> }; elapsedMs: number }

export const DEFAULT_TIMEOUT_MS = 120_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`), { code: 'timeout' })), ms);
    const onAbort = (): void => { clearTimeout(timer); reject(new ActionError('cancelled', `${label} cancelled by the client`)); };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    p.then((v) => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); resolve(v); },
           (e) => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

export async function runAdapter(
  provider: PageProvider,
  cmd: AdapterCommand,
  rawArgs: Record<string, unknown>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CommandRunResult | CommandRunError> {
  const started = Date.now();
  const key = `${cmd.site}/${cmd.name}`;
  try {
    const args = coerceArgs(cmd.args, rawArgs);
    let ctx: { args: Record<string, unknown>; tab: unknown; sites: unknown; recon: unknown; signal?: AbortSignal };
    if (cmd.browser) {
      if (!provider.browserAvailable()) {
        throw new ActionError('browser_unavailable', `${key} needs a logged-in browser, but the Chrome extension is not connected`, 'Install the opencli-mcp extension and keep Chrome running (run `opencli-mcp doctor`).');
      }
      const page = await provider.getAdapterPage(cmd.site, { siteSession: 'persistent', windowMode: 'background', navigateTo: cmd.domain ? `https://${cmd.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}/` : undefined });
      const model = await provider.toolContext(page, cmd.site);
      ctx = { args, tab: model.tab, sites: model.sites, recon: model.recon, signal: opts.signal };
    } else {
      ctx = { args, tab: undefined, sites: undefined, recon: undefined, signal: opts.signal };
    }
    const result = await withTimeout(Promise.resolve(cmd.run(ctx)), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, key, opts.signal);
    const elapsedMs = Date.now() - started;
    if (Array.isArray(result)) return { ok: true, site: cmd.site, name: cmd.name, rows: result, elapsedMs };
    if (result && typeof result === 'object') {
      const o = result as { rows?: unknown; nextCursor?: unknown };
      if (Array.isArray(o.rows)) return { ok: true, site: cmd.site, name: cmd.name, rows: o.rows, ...(typeof o.nextCursor === 'string' && { nextCursor: o.nextCursor }), elapsedMs };
      return { ok: true, site: cmd.site, name: cmd.name, value: result, elapsedMs };
    }
    return { ok: true, site: cmd.site, name: cmd.name, value: result, elapsedMs };
  } catch (err) {
    const e = err as { code?: string; message?: string; hint?: string; details?: Record<string, unknown> };
    return {
      ok: false, site: cmd.site, name: cmd.name, elapsedMs: Date.now() - started,
      error: { code: e.code ?? 'command_failed', message: String(e.message ?? err), ...(e.hint && { hint: e.hint }), ...(e.details && { details: e.details }) },
    };
  }
}
