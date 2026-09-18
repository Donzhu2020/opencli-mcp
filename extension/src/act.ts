/** Extension edge of the interaction engine: engine-world evaluation, CDP on the attached tab, cursor overlay, navigation wait. */
import type { ActSpec, ActResult } from '../../src/protocol.js';
import type { FrameStep } from '../../src/protocol.js';
import { performAct as run, ActError, frameSteps, FRAME_MARK } from '../../src/shared/engine';
import * as executor from './cdp';
import { callPage, evaluateInWorld, frameCommand } from './world';

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
 * Enter `target.frame` step by step, the way Codex chains `>> internal:control=enter-frame >>`: each step is resolved in
 * the engine world of the frame reached so far (main → child → grandchild …), the marked <iframe> element is mapped to
 * its CDP frameId with DOM.describeNode on that frame's own session, and the iframe's viewport offset accumulates.
 * Same-origin, in-process cross-origin (data:/srcdoc) and out-of-process frames all route the same way.
 */
async function routeFrames(tabId: number, steps: FrameStep[], aggressive: boolean): Promise<{ frameId: string; offset: { x: number; y: number } } | null> {
  if (!steps.length) return null;
  let frameId: string | null = null;
  const offset = { x: 0, y: 0 };
  for (const [depth, step] of steps.entries()) {
    const where = frameId === null ? 'the document' : `frame ${depth} (${steps[depth - 1]})`;
    const probe = await callPage(tabId, frameId, 'frameProbe', { step }, aggressive, 5_000) as { found: boolean; x?: number; y?: number };
    if (!probe.found) throw new ActError('frame_not_found', `no iframe matches ${JSON.stringify(step)} in ${where}`, 'Pass the css selector of the <iframe> or its 0-based index among iframes in that frame; chain steps outermost first.');
    const probedIn = frameId;
    try {
      const objectId = await evaluateInWorld(tabId, frameId, `document.querySelector('[${FRAME_MARK}]')`, aggressive, 5_000, false) as string | undefined;
      if (!objectId) throw new ActError('frame_unreachable', `the iframe ${JSON.stringify(step)} vanished while routing`, 'Observe and retry.');
      const { node } = await frameCommand(tabId, frameId, 'DOM.describeNode', { objectId }, aggressive, 5_000) as { node: { frameId?: string } };
      await frameCommand(tabId, frameId, 'Runtime.releaseObject', { objectId }, aggressive, 2_000).catch(() => {});
      if (!node.frameId) throw new ActError('frame_unreachable', `the iframe ${JSON.stringify(step)} has no frame id yet`, 'The frame may still be loading; observe and retry.');
      offset.x += probe.x ?? 0; offset.y += probe.y ?? 0;
      frameId = node.frameId;
    } finally {
      await callPage(tabId, probedIn, 'clearFrameMark', undefined, aggressive, 2_000).catch(() => {});
    }
  }
  return frameId === null ? null : { frameId, offset };
}

export async function performAct(tabId: number, spec: ActSpec, opts: { aggressive: boolean; cursor?: (x: number, y: number) => Promise<unknown> }): Promise<ActResult> {
  await executor.ensureAttached(tabId, opts.aggressive);
  const route = typeof spec.target.x === 'number' ? null : await routeFrames(tabId, frameSteps(spec.target.frame), opts.aggressive);
  if (route) {
    const { frame: _frame, ...target } = spec.target;
    return run({
      call: (fn, args, timeoutMs) => callPage(tabId, route.frameId, fn, args, opts.aggressive, timeoutMs),
      // DOM.* must address the frame's own session (node ids are per session); Input.* is dispatched on the tab and routed by Chrome
      cdp: (method, params) => method.startsWith('DOM.') ? frameCommand(tabId, route.frameId, method, params ?? {}, opts.aggressive) : executor.sendDebuggerCommand({ tabId }, method, params),
      cursor: opts.cursor,
      waitForNavigation: (classifyMs, timeoutMs) => waitForNavigation(tabId, classifyMs, timeoutMs),
      pointOffset: route.offset,
    }, { ...spec, target });
  }
  return run({
    call: (fn, args, timeoutMs) => callPage(tabId, null, fn, args, opts.aggressive, timeoutMs),
    cdp: (method, params) => executor.sendDebuggerCommand({ tabId }, method, params),
    cursor: opts.cursor,
    waitForNavigation: (classifyMs, timeoutMs) => waitForNavigation(tabId, classifyMs, timeoutMs),
  }, spec);
}
