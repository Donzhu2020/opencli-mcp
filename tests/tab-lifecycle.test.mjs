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

  it('saves the last activity time when an owned tab is used', async () => {
    chromeMock();
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('active');
    session.leases.set(1, { tabId: 1, origin: 'agent', mark: null, claimedAt: Date.now(), state: 'active' });
    await manager.resolveTab(session, 'page-1');
    const saved = globalThis.chrome.storage.session.set.mock.lastCall[0].opencli_mcp_sessions_v1[0];
    expect(saved.lastActivity).toBe(session.lastActivity);
  });

  it('removes a new tab if navigation cannot begin', async () => {
    const tabs = chromeMock();
    tabs.create.mockResolvedValue({ id: 1, url: 'about:blank', windowId: 1 });
    tabs.update.mockRejectedValueOnce(new Error('blocked navigation'));
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('test');
    session.windowId = 1;
    await expect(manager.createTab(session, 'https://example.com/')).rejects.toMatchObject({ code: 'page_not_loaded' });
    expect(tabs.remove).toHaveBeenCalledWith(1);
    expect(session.leases.size).toBe(0);
    expect(tabs.onUpdated.removeListener).toHaveBeenCalledOnce();
  });

  it('removes a new tab if it cannot join the session group', async () => {
    const tabs = chromeMock();
    tabs.create.mockResolvedValue({ id: 1, url: 'about:blank', windowId: 1 });
    tabs.group.mockRejectedValue(new Error('group unavailable'));
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('test');
    session.windowId = 1;
    await expect(manager.createTab(session)).rejects.toThrow('group unavailable');
    expect(tabs.remove).toHaveBeenCalledWith(1);
    expect(session.leases.size).toBe(0);
  });

  it('keeps ownership if cleanup of a failed new tab also fails', async () => {
    const tabs = chromeMock();
    tabs.create.mockResolvedValue({ id: 1, url: 'about:blank', windowId: 1 });
    tabs.group.mockRejectedValue(new Error('group unavailable'));
    tabs.remove.mockRejectedValue(new Error('remove blocked'));
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('test');
    session.windowId = 1;
    await expect(manager.createTab(session)).rejects.toMatchObject({ code: 'tab_create_cleanup_failed' });
    expect(session.leases.get(1)).toMatchObject({ origin: 'agent', state: 'active' });
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

  it('remembers released tabs across a service-worker restart', async () => {
    chromeMock();
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('first');
    session.leases.set(1, { tabId: 1, origin: 'user', mark: null, claimedAt: Date.now(), state: 'active' });
    await manager.endTab(session, 1, 'release');
    const saved = globalThis.chrome.storage.session.set.mock.lastCall[0];
    expect(saved.opencli_mcp_released_v2).toEqual([1]);
    globalThis.chrome.storage.session.get.mockResolvedValue(saved);
    const restarted = new SessionManager(() => {});
    await restarted.ready();
    await expect(restarted.resolveTab(restarted.get('second'), 'page-1')).rejects.toMatchObject({ code: 'page_released' });
  });

  it('ungroups and unmutes an agent tab when released', async () => {
    const tabs = chromeMock();
    tabs.get.mockResolvedValue({ id: 1, url: 'https://example.com/', windowId: 1, groupId: 10 });
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('test');
    session.leases.set(1, { tabId: 1, origin: 'agent', mark: null, claimedAt: Date.now(), state: 'active' });
    await manager.endTab(session, 1, 'release');
    expect(tabs.ungroup).toHaveBeenCalledWith(1);
    expect(tabs.update).toHaveBeenCalledWith(1, { muted: false });
    expect(tabs.remove).not.toHaveBeenCalled();
  });

  it('retains the lease if releasing an agent tab cannot ungroup it', async () => {
    const tabs = chromeMock();
    tabs.get.mockResolvedValue({ id: 1, url: 'https://example.com/', windowId: 1, groupId: 10 });
    tabs.ungroup.mockRejectedValueOnce(new Error('group failed'));
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('test');
    session.leases.set(1, { tabId: 1, origin: 'agent', mark: null, claimedAt: Date.now(), state: 'active' });
    await expect(manager.endTab(session, 1, 'release')).rejects.toMatchObject({ code: 'tab_release_failed' });
    expect(session.leases.has(1)).toBe(true);
    await manager.endTab(session, 1, 'release');
    expect(session.leases.has(1)).toBe(false);
  });

  it('treats a tab that Chrome already removed as closed', async () => {
    const tabs = chromeMock();
    tabs.remove.mockRejectedValueOnce(new Error('No tab with id: 1'));
    tabs.get.mockRejectedValueOnce(new Error('No tab with id: 1'));
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('test');
    session.leases.set(1, { tabId: 1, origin: 'agent', mark: null, claimedAt: Date.now(), state: 'active' });
    expect(await manager.endTab(session, 1, 'close')).toMatchObject({ closed: true });
    expect(session.leases.has(1)).toBe(false);
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

  it('preserves agent origin when another session claims a handoff tab', async () => {
    chromeMock();
    const events = [];
    const manager = new SessionManager((value) => events.push(value));
    await manager.ready();
    manager.get('first').leases.set(1, { tabId: 1, origin: 'agent', mark: 'handoff', claimedAt: Date.now(), state: 'handoff' });
    const second = manager.get('second');
    await manager.claimUserTab(second, { tabId: 1 });
    expect(second.leases.get(1).origin).toBe('agent');
    expect(events.at(-1)).toMatchObject({ kind: 'tab_acquired', origin: 'agent' });
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
