import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { createExtensionPage } from '../src/backends/extension-page.js';
import { BrowserCommandError, type ExtensionBridge } from '../src/host/bridge.js';
import type { Command } from '../src/protocol.js';

describe('extension page transport', () => {
  it('evaluates source and fetches JSON through the page context', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', url: 'https://example.test/api', headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{"saved":true}' }));
    const send = vi.fn(async (_action: string, params: Partial<Command>) => ({ data: await runInNewContext(params.code!, { fetch, AbortController, setTimeout, clearTimeout }) }));
    const page = await createExtensionPage({ send } as unknown as ExtensionBridge, { session: 'test', surface: 'browser', page: 'tab-1' });
    expect(await page.evaluate('() => 42')).toBe(42);
    expect(await page.evaluateWithArgs('return value + 1;', { value: 4 })).toBe(5);
    expect(await page.fetchJson('https://example.test/api', { method: 'POST', body: { title: 'hello' } })).toEqual({ saved: true });
    expect(fetch).toHaveBeenCalledWith('https://example.test/api', expect.objectContaining({ method: 'POST', credentials: 'include', body: '{"title":"hello"}' }));
    expect(send).toHaveBeenLastCalledWith('exec', expect.objectContaining({ session: 'test', page: 'tab-1' }));
  });

  it('retries a navigation failure once but never retries a mid-command timeout', async () => {
    const send = vi.fn().mockRejectedValueOnce(new BrowserCommandError('navigation', 'target_navigated')).mockResolvedValueOnce({ data: 'ready' });
    const page = await createExtensionPage({ send } as unknown as ExtensionBridge, { session: 'test', surface: 'browser', page: 'tab-1' });
    expect(await page.evaluate('document.title')).toBe('ready');
    expect(send).toHaveBeenCalledTimes(2);
    send.mockReset().mockRejectedValue(new BrowserCommandError('execution context -32000', 'cdp_timeout'));
    await expect(page.evaluate('document.title')).rejects.toMatchObject({ code: 'cdp_timeout' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
