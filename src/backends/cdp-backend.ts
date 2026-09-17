/** Direct CDP backend (Electron apps, remote/headless Chrome) via OpenCLI's CDPBridge. */
import { CDPBridge } from '@jackwener/opencli/browser/cdp';
import type { RuntimePage } from './page-types.js';

export interface CdpBackendHandle { page: RuntimePage; close(): Promise<void> }

export async function connectCdpBackend(opts: { endpoint: string; session: string; surface: 'browser' | 'adapter'; timeoutMs?: number }): Promise<CdpBackendHandle> {
  const bridge = new CDPBridge();
  const page = await bridge.connect({ cdpEndpoint: opts.endpoint, session: opts.session, surface: opts.surface, timeout: Math.round((opts.timeoutMs ?? 30_000) / 1000) });
  Object.assign(page as object, { session: opts.session, surface: opts.surface });
  return { page: page as unknown as RuntimePage, close: () => bridge.close() };
}
