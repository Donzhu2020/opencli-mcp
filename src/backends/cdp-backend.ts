/** Direct CDP backend (Electron apps, remote/headless Chrome) via OpenCLI's CDPBridge, adapted to the RuntimePage surface. */
import { CDPBridge } from '@jackwener/opencli/browser/cdp';
import type { IPage } from '@jackwener/opencli/types';
import type { RuntimePage } from './page-types.js';
import { performAct } from '../shared/act-core.js';
import type { ActSpec } from '../protocol.js';

export interface CdpBackendHandle { page: RuntimePage; close(): Promise<void> }

const unsupported = (what: string) => () => Promise.reject(Object.assign(new Error(`${what} is not available on the direct CDP backend`), { code: 'unsupported_backend', hint: 'Use the Chrome extension backend for multi-tab/session features.' }));

/** OpenCLI's CDPPage drives one target; give it the identity bookkeeping the object model expects. */
function adapt(page: IPage, session: string, surface: 'browser' | 'adapter', close: () => Promise<void>): RuntimePage {
  const p = page as IPage & Partial<RuntimePage>;
  let active: string | undefined = `cdp:${session}`;
  const extras: Partial<RuntimePage> = {
    session, surface,
    getActivePage: () => active,
    setActivePage: (id?: string) => { active = id; },
    closeWindow: async () => { await close(); },
    newTab: unsupported('newTab'),
    closeTab: async () => { await close(); active = undefined; },
    frames: async () => [],
    evaluateInFrame: unsupported('evaluateInFrame'),
    setFileInput: p.setFileInput?.bind(p) ?? unsupported('setFileInput'),
    insertText: p.insertText?.bind(p) ?? (async (text: string) => { await p.cdp?.('Input.insertText', { text }); }),
    waitForDownload: p.waitForDownload?.bind(p) ?? unsupported('waitForDownload'),
    startNetworkCapture: p.startNetworkCapture?.bind(p) ?? (async () => false),
    readNetworkCapture: p.readNetworkCapture?.bind(p) ?? (async () => []),
    getCurrentUrl: p.getCurrentUrl?.bind(p) ?? (async () => (await p.evaluate<string>('location.href')) ?? null),
    annotatedScreenshot: p.annotatedScreenshot?.bind(p) ?? ((o) => p.screenshot(o)),
    act: (spec: ActSpec) => performAct({ evaluate: (js) => p.evaluate(js), cdp: (m, params) => { if (!p.cdp) throw Object.assign(new Error('cdp not available'), { code: 'unsupported_backend' }); return p.cdp(m, params); } }, spec),
  };
  const obj = p as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(extras)) if (obj[k] === undefined || ['session', 'surface', 'getActivePage', 'setActivePage', 'closeWindow', 'closeTab', 'act'].includes(k)) obj[k] = v;
  // tabs(): expose the single target with a page id so Browser.tabs.list() works
  const origTabs = p.tabs.bind(p);
  obj.tabs = async () => { const t = await origTabs().catch(() => [] as unknown[]); const first = (t as Array<Record<string, unknown>>)[0] ?? {}; return [{ page: active, url: first.url, title: first.title, active: true }]; };
  return p as RuntimePage;
}

export async function connectCdpBackend(opts: { endpoint: string; session: string; surface: 'browser' | 'adapter'; timeoutMs?: number }): Promise<CdpBackendHandle> {
  const bridge = new CDPBridge();
  const raw = await bridge.connect({ cdpEndpoint: opts.endpoint, session: opts.session, surface: opts.surface, timeout: Math.round((opts.timeoutMs ?? 30_000) / 1000) });
  const close = () => bridge.close();
  return { page: adapt(raw, opts.session, opts.surface, close), close };
}
