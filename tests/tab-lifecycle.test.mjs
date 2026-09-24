import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../extension/src/sessions.js';

vi.mock('../extension/src/cdp.js', () => ({ ensureAttached: vi.fn(async () => {}), detach: vi.fn(async () => {}) }));

const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });

function chromeMock() {
  const tabs = {
    onRemoved: event(), onActivated: event(), onUpdated: event(),
    get: vi.fn(async (tabId) => ({ id: tabId, url: 'https://example.com/', windowId: 1 })),
    remove: vi.fn(async (_tabId) => {}),
    ungroup: vi.fn(async (_tabId) => {}),
    update: vi.fn(async (_tabId, _change) => {}),
    query: vi.fn(async () => []),
    create: vi.fn(),
    group: vi.fn(async () => 10),
  };
  vi.stubGlobal('chrome', {
    tabs,
    debugger: { getTargets: vi.fn(async () => [{ id: 'page-1', type: 'page', tabId: 1 }]) },
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    windows: { onFocusChanged: event(), onRemoved: event() },
    runtime: { onMessage: event() },
    tabGroups: { onRemoved: event(), update: vi.fn(async () => {}) },
    webNavigation: { onCreatedNavigationTarget: event(), onErrorOccurred: event() },
  });
  return tabs;
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('browser tab ownership', () => {
  it('resumes idle cleanup after a service-worker restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T00:00:00Z'));
    const tabs = chromeMock();
    globalThis.chrome.storage.session.get.mockResolvedValue({
      opencli_mcp_sessions_v1: [{
        key: 'restored', surface: 'browser', name: null, groupId: 10, windowId: 1,
        leases: [{ tabId: 1, origin: 'agent', mark: null, claimedAt: Date.now() - 60_000, state: 'active' }],
        preferredTabId: 1, visible: false, lastActivity: Date.now() - 60 * 60_000 + 1000,
      }],
      opencli_mcp_released_v2: [],
    });
    const manager = new SessionManager(() => {});
    await manager.ready();
    expect(manager.sessions.has('restored')).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tabs.remove).toHaveBeenCalledWith(1);
    expect(manager.sessions.has('restored')).toBe(false);
  });

  it('requires explicit open or claim and never adopts an unknown page', async () => {
    const tabs = chromeMock();
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('test');
    await expect(manager.resolveTab(session)).rejects.toMatchObject({ code: 'no_tab' });
    await expect(manager.resolveTab(session, 'page-1')).rejects.toMatchObject({ code: 'page_not_in_session' });
    expect(session.leases.size).toBe(0);
    expect(tabs.create).not.toHaveBeenCalled();
  });

  it('releases a claimed user tab without closing it and closes only on explicit close', async () => {
    const tabs = chromeMock();
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('test');
    const lease = { tabId: 1, origin: 'user', mark: null, claimedAt: Date.now(), state: 'active' };
    session.leases.set(1, lease);
    expect(await manager.endTab(session, 1, 'release')).toMatchObject({ closed: false, released: true });
    expect(tabs.remove).not.toHaveBeenCalled();
    expect(tabs.ungroup).not.toHaveBeenCalled();
    session.leases.set(1, lease);
    expect(await manager.endTab(session, 1, 'close')).toMatchObject({ closed: true, released: false });
    expect(tabs.remove).toHaveBeenCalledWith(1);
  });

  it('reports failed cleanup and keeps its lease for retry', async () => {
    const tabs = chromeMock();
    tabs.remove.mockRejectedValueOnce(new Error('cannot remove'));
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('test');
    session.leases.set(1, { tabId: 1, origin: 'agent', mark: null, claimedAt: Date.now(), state: 'active' });
    const result = await manager.finalize(session, []);
    expect(result).toMatchObject({ closed: [], kept: [], failed: [{ page: 'page-1' }] });
    expect(session.leases.has(1)).toBe(true);
  });
});
