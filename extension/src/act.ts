/** Extension edge of the shared interaction engine: evaluate/CDP on an attached tab + cursor overlay. */
import type { ActSpec, ActResult } from '../../src/protocol.js';
import { performAct as run, ActError } from '../../src/shared/act-core';
import * as executor from './cdp';

export { ActError };

export async function performAct(tabId: number, spec: ActSpec, opts: { aggressive: boolean; cursor?: (x: number, y: number) => Promise<unknown> }): Promise<ActResult> {
  await executor.ensureAttached(tabId, opts.aggressive);
  return run({
    evaluate: (js, timeoutMs) => executor.evaluate(tabId, js, opts.aggressive, timeoutMs),
    cdp: (method, params) => executor.sendDebuggerCommand({ tabId }, method, params),
    cursor: opts.cursor,
  }, spec);
}
