/** Extension edge of the interaction engine: engine-world evaluation, CDP on the attached tab, cursor overlay, navigation wait. */
import type { ActSpec, ActResult } from '../../src/protocol.js';
import { performAct as run, ActError } from '../../src/shared/engine';
import * as executor from './cdp';
import { evaluateInEngine } from './world';

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

export async function performAct(tabId: number, spec: ActSpec, opts: { aggressive: boolean; cursor?: (x: number, y: number) => Promise<unknown> }): Promise<ActResult> {
  await executor.ensureAttached(tabId, opts.aggressive);
  return run({
    evaluate: (js, timeoutMs) => evaluateInEngine(tabId, js, opts.aggressive, timeoutMs),
    cdp: (method, params) => executor.sendDebuggerCommand({ tabId }, method, params),
    cursor: opts.cursor,
    waitForNavigation: (classifyMs, timeoutMs) => waitForNavigation(tabId, classifyMs, timeoutMs),
  }, spec);
}
