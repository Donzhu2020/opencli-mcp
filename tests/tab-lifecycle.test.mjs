import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../extension/src/sessions.js';

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
  };
  vi.stubGlobal('chrome', {
    tabs,
    debugger: { getTargets: vi.fn(async () => [{ id: 'page-1', type: 'page', tabId: 1 }]) },
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    windows: { onFocusChanged: event(), onRemoved: event() },
    runtime: { onMessage: event() },
    tabGroups: { onRemoved: event() },
    webNavigation: { onCreatedNavigationTarget: event(), onErrorOccurred: event() },
  });
  return tabs;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('browser tab ownership', () => {
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

  it('ungroups and unmutes an agent tab when released', async () => {
    const tabs = chromeMock();
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('test');
    session.leases.set(1, { tabId: 1, origin: 'agent', mark: null, claimedAt: Date.now(), state: 'active' });
    await manager.endTab(session, 1, 'release');
    expect(tabs.ungroup).toHaveBeenCalledWith(1);
    expect(tabs.update).toHaveBeenCalledWith(1, { muted: false });
    expect(tabs.remove).not.toHaveBeenCalled();
  });

  it('keeps the lease when Chrome refuses to close a tab', async () => {
    const tabs = chromeMock();
    tabs.remove.mockRejectedValueOnce(new Error('cannot remove'));
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('test');
    session.leases.set(1, { tabId: 1, origin: 'user', mark: null, claimedAt: Date.now(), state: 'active' });
    session.preferredTabId = 1;
    await expect(manager.endTab(session, 1, 'close')).rejects.toMatchObject({ code: 'tab_close_failed' });
    expect(session.leases.has(1)).toBe(true);
    expect(session.preferredTabId).toBe(1);
  });

  it('searches and bounds user tab discovery without returning controlled tabs', async () => {
    const tabs = chromeMock();
    tabs.query.mockResolvedValue([
      { id: 1, url: 'https://example.com/owned', title: 'Example owned', windowId: 1, active: false, lastAccessed: 30 },
      { id: 2, url: 'https://example.com/older', title: 'Example older', windowId: 1, active: false, lastAccessed: 10 },
      { id: 3, url: 'https://example.com/newer', title: 'Example newer', windowId: 1, active: true, lastAccessed: 20 },
      { id: 4, url: 'https://other.test/', title: 'Other', windowId: 1, active: false, lastAccessed: 40 },
    ]);
    const manager = new SessionManager(() => {});
    await manager.ready();
    manager.get('test').leases.set(1, { tabId: 1, origin: 'agent', mark: null, claimedAt: Date.now(), state: 'active' });
    expect((await manager.listUserTabs({ query: 'EXAMPLE', limit: 1 })).map((tab) => tab.tabId)).toEqual([3]);
    expect((await manager.listUserTabs({ query: 'example' })).map((tab) => tab.tabId)).toEqual([3, 2]);
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

  it('persists lease snapshots in mutation order', async () => {
    chromeMock();
    let finishFirst;
    const write = globalThis.chrome.storage.session.set;
    write.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('test');
    const first = manager.nameSession(session, 'first');
    const second = manager.nameSession(session, 'second');
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(write.mock.calls[0][0].opencli_mcp_sessions_v1[0].name).toBe('first');
    finishFirst();
    await Promise.all([first, second]);
    expect(write.mock.calls[1][0].opencli_mcp_sessions_v1[0].name).toBe('second');
  });
});
