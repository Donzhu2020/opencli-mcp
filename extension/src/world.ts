/**
 * Engine world — an isolated world per frame where Playwright's injected script lives, so page scripts
 * cannot see or tamper with it (the same arrangement the ChatGPT plugin uses). Contexts are cached per
 * tab+frame and rebuilt when Chrome reports the context gone.
 */
import * as executor from './cdp';
import { INJECTED_SOURCE } from '../../src/shared/injected-source';
import { ENGINE_GLOBAL, installEngineJs } from '../../src/shared/engine';

const WORLD_NAME = 'opencli-mcp-engine';
const contexts = new Map<string, number>(); // `${tabId}:${frameId}` → executionContextId

function key(tabId: number, frameId: string): string { return `${tabId}:${frameId}`; }

export function forgetTab(tabId: number): void {
  for (const k of [...contexts.keys()]) if (k.startsWith(`${tabId}:`)) contexts.delete(k);
}

async function mainFrameId(tabId: number): Promise<string> {
  const { frameTree } = await executor.sendDebuggerCommand({ tabId }, 'Page.getFrameTree') as { frameTree: { frame: { id: string } } };
  return frameTree.frame.id;
}

async function ensureContext(tabId: number, aggressive: boolean): Promise<number> {
  await executor.ensureAttached(tabId, aggressive);
  const frameId = await mainFrameId(tabId);
  const k = key(tabId, frameId);
  const cached = contexts.get(k);
  if (cached !== undefined) return cached;
  const { executionContextId } = await executor.sendDebuggerCommand({ tabId }, 'Page.createIsolatedWorld', { frameId, worldName: WORLD_NAME, grantUniveralAccess: true }) as { executionContextId: number };
  contexts.set(k, executionContextId);
  await evaluateIn(tabId, executionContextId, installEngineJs(INJECTED_SOURCE), 15_000);
  return executionContextId;
}

async function evaluateIn(tabId: number, contextId: number, expression: string, timeoutMs?: number): Promise<unknown> {
  const r = await executor.sendDebuggerCommand({ tabId }, 'Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true, userGesture: true }, timeoutMs) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'evaluate failed');
  return r.result?.value;
}

async function ensureFrameContext(tabId: number, frameId: string, aggressive: boolean): Promise<number> {
  const k = key(tabId, frameId);
  const cached = contexts.get(k);
  if (cached !== undefined) return cached;
  const { executionContextId } = await executor.sendCommandInFrameTarget(tabId, frameId, 'Page.createIsolatedWorld', { frameId, worldName: WORLD_NAME, grantUniveralAccess: true }, aggressive) as { executionContextId: number };
  contexts.set(k, executionContextId);
  await evaluateInFrameCtx(tabId, frameId, executionContextId, installEngineJs(INJECTED_SOURCE), aggressive, 15_000);
  return executionContextId;
}

async function evaluateInFrameCtx(tabId: number, frameId: string, contextId: number, expression: string, aggressive: boolean, timeoutMs?: number): Promise<unknown> {
  const r = await executor.sendCommandInFrameTarget(tabId, frameId, 'Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true, userGesture: true }, aggressive, timeoutMs) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'evaluate failed');
  return r.result?.value;
}

/** Evaluate in the engine world of an out-of-process iframe (its own debugger target), installing the engine on first use. */
export async function evaluateInFrameEngine(tabId: number, frameId: string, expression: string, aggressive: boolean, timeoutMs?: number): Promise<unknown> {
  const run = async () => { const ctx = await ensureFrameContext(tabId, frameId, aggressive); return evaluateInFrameCtx(tabId, frameId, ctx, `(() => { if (!globalThis.${ENGINE_GLOBAL}) throw new Error('engine_missing'); return (${expression}); })()`, aggressive, timeoutMs); };
  try { return await run(); } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/Cannot find context|context was destroyed|engine_missing|not found|Inspected target navigated/i.test(msg)) { contexts.delete(key(tabId, frameId)); return run(); }
    throw err;
  }
}

/** Evaluate in the engine world; installs the engine on first use and recovers from a destroyed context once. */
export async function evaluateInEngine(tabId: number, expression: string, aggressive: boolean, timeoutMs?: number): Promise<unknown> {
  const run = async () => { const ctx = await ensureContext(tabId, aggressive); return evaluateIn(tabId, ctx, `(() => { if (!globalThis.${ENGINE_GLOBAL}) throw new Error('engine_missing'); return (${expression}); })()`, timeoutMs); };
  try { return await run(); } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/Cannot find context|context was destroyed|engine_missing|not found|Inspected target navigated/i.test(msg)) { forgetTab(tabId); return run(); }
    throw err;
  }
}
