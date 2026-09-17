/** OpenCLI plugin hooks: re-exported so plugins that registered hooks still fire inside opencli-mcp. */
import { onStartup, onBeforeExecute, onAfterExecute, type HookFn, type HookContext, type HookName } from '@jackwener/opencli/registry';
export { onStartup, onBeforeExecute, onAfterExecute };
export type { HookContext, HookName };
export async function emitHook(name: HookName, ctx: HookContext, result?: unknown): Promise<void> {
  const store = (globalThis as { __opencli_hooks__?: Map<HookName, HookFn[]> }).__opencli_hooks__;
  const fns = store?.get(name) ?? [];
  for (const fn of fns) { try { await fn(ctx, result); } catch (err) { process.stderr.write(`[opencli-mcp] hook ${name} failed: ${(err as Error).message}\n`); } }
}
