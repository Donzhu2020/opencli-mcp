/** Extension edge of the interaction engine: engine-world evaluation, CDP on the attached tab, cursor overlay, navigation wait. */
import type { ActSpec, ActResult } from '../../src/protocol.js';
import { performAct as run, ActError, frameProbeJs, FRAME_MARK } from '../../src/shared/engine';
import * as executor from './cdp';
import { evaluateInEngine, evaluateInFrameEngine } from './world';

export { ActError };

/** Resolve once a navigation started within `classifyMs` has finished (or immediately with navigated:false). */
export function waitForNavigation(tabId: number, classifyMs: number, timeoutMs: number): Promise<{ navigated: boolean; url?: string }> {
  return new Promise((resolve) => {
    let started = false; let done = false;
    const finish = (navigated: boolean, url?: string) => { if (done) return; done = true; chrome.webNavigation.onBeforeNavigate.removeListener(onStart); chrome.webNavigation.onCompleted.removeListener(onEnd); chrome.webNavigation.onErrorOccurred.removeListener(onEnd); chrome.tabs.onUpdated.removeListener(onUpdated); clearTimeout(classify); clearTimeout(overall); resolve({ navigated, url }); };
    type NavDetails = { tabId: number; frameId: number; url: string };
    const onStart = (d: NavDetails) => { if (d.tabId === tabId && d.frameId === 0) { started = true; clearTimeout(classify); } };
    const onEnd = (d: NavDetails) => { if (started && d.tabId === tabId && d.frameId === 0) finish(true, d.url); };
    const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => { if (id === tabId && started && info.status === 'complete') finish(true, tab.url); };
    chrome.webNavigation.onBeforeNavigate.addListener(onStart);
    chrome.webNavigation.onCompleted.addListener(onEnd);
    chrome.webNavigation.onErrorOccurred.addListener(onEnd);
    chrome.tabs.onUpdated.addListener(onUpdated);
    const classify = setTimeout(() => { if (!started) finish(false); }, classifyMs);
    const overall = setTimeout(() => finish(started), timeoutMs);
  });
}

/**
 * Cross-origin iframes live in another renderer: the same-origin path inside the resolver cannot reach them. Like the
 * plugin's enter-frame routing (targetForFrameOrAttach + DOM.getFrameOwner), map the marked <iframe> element to its
 * CDP frameId and run the engine in that frame's own target; input events still go to the tab, shifted by the iframe's box.
 */
async function routeFrame(tabId: number, frame: string | number, aggressive: boolean): Promise<{ frameId: string; offset: { x: number; y: number } } | null> {
  const probe = await evaluateInEngine(tabId, frameProbeJs(frame), aggressive, 5_000) as { found: boolean; sameOrigin?: boolean; x?: number; y?: number; src?: string };
  if (!probe.found) throw new ActError('frame_not_found', `no iframe matches ${JSON.stringify(frame)}`, 'Pass the css selector of the <iframe> or its 0-based index among iframes in the document.');
  if (probe.sameOrigin) return null;
  try {
    const doc = await executor.sendDebuggerCommand({ tabId }, 'DOM.getDocument', { depth: 0 }) as { root: { nodeId: number } };
    const q = await executor.sendDebuggerCommand({ tabId }, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector: `[${FRAME_MARK}]` }) as { nodeId: number };
    const { node } = await executor.sendDebuggerCommand({ tabId }, 'DOM.describeNode', { nodeId: q.nodeId }) as { node: { frameId?: string } };
    if (!node.frameId) throw new Error('iframe element has no frameId');
    return { frameId: node.frameId, offset: { x: probe.x ?? 0, y: probe.y ?? 0 } };
  } finally {
    await evaluateInEngine(tabId, `document.querySelectorAll('[${FRAME_MARK}]').forEach((n) => n.removeAttribute('${FRAME_MARK}'))`, aggressive, 2_000).catch(() => {});
  }
}

export async function performAct(tabId: number, spec: ActSpec, opts: { aggressive: boolean; cursor?: (x: number, y: number) => Promise<unknown> }): Promise<ActResult> {
  await executor.ensureAttached(tabId, opts.aggressive);
  const route = spec.target.frame !== undefined && !(typeof spec.target.x === 'number') ? await routeFrame(tabId, spec.target.frame, opts.aggressive) : null;
  if (route) {
    const { frame: _frame, ...target } = spec.target;
    return run({
      evaluate: (js, timeoutMs) => evaluateInFrameEngine(tabId, route.frameId, js, opts.aggressive, timeoutMs),
      // DOM.* must address the frame's own target (node ids are per session); Input.* is dispatched on the tab and routed by Chrome
      cdp: (method, params) => method.startsWith('DOM.') ? executor.sendCommandInFrameTarget(tabId, route.frameId, method, params, opts.aggressive) : executor.sendDebuggerCommand({ tabId }, method, params),
      cursor: opts.cursor,
      waitForNavigation: (classifyMs, timeoutMs) => waitForNavigation(tabId, classifyMs, timeoutMs),
      pointOffset: route.offset,
    }, { ...spec, target });
  }
  return run({
    evaluate: (js, timeoutMs) => evaluateInEngine(tabId, js, opts.aggressive, timeoutMs),
    cdp: (method, params) => executor.sendDebuggerCommand({ tabId }, method, params),
    cursor: opts.cursor,
    waitForNavigation: (classifyMs, timeoutMs) => waitForNavigation(tabId, classifyMs, timeoutMs),
  }, spec);
}
