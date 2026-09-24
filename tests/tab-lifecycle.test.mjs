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
    debugger: { getTargets: vi.fn(async () => [1, 2, 3, 4].map((tabId) => ({ id: `page-${tabId}`, type: 'page', tabId }))) },
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    windows: { onFocusChanged: event(), onRemoved: event() },
    runtime: { onMessage: event() },
    tabGroups: { onRemoved: event(), update: vi.fn(async () => {}) },
    webNavigation: { onCreatedNavigationTarget: event(), onErrorOccurred: event() },
  });
  return tabs;
}

function emptyWindowMock() {
  const tabs = chromeMock();
  const initialTab = { id: 1, windowId: 1, url: 'about:blank', status: 'complete', active: true };
  let open = true;
  tabs.get.mockImplementation(async () => { if (!open) throw new Error('No tab with id: 1'); return initialTab; });
  tabs.update.mockImplementation(async (_id, change) => {
    Object.assign(initialTab, change);
    if (change.url) for (const [listener] of tabs.onUpdated.addListener.mock.calls) listener(1, { status: 'complete' }, initialTab);
    return initialTab;
  });
  tabs.remove.mockImplementation(async () => { open = false; });
  tabs.query.mockImplementation(async () => open ? [initialTab] : []);
  globalThis.chrome.windows.getLastFocused = vi.fn(async () => null);
  globalThis.chrome.windows.getAll = vi.fn(async () => []);
  globalThis.chrome.windows.get = vi.fn(async () => ({ id: 1 }));
  globalThis.chrome.windows.create = vi.fn(async () => ({ id: 1, tabs: [initialTab] }));
  return tabs;
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('browser tab ownership', () => {
  it.each(['browser', 'adapter'])('uses the initial tab of a new %s window', async (surface) => {
    const tabs = emptyWindowMock();
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('new-window', surface);
    const opened = await manager.createTab(session, 'https://example.com/');
    expect(opened.tabId).toBe(1);
    expect(tabs.create).not.toHaveBeenCalled();
    expect(session.leases.has(1)).toBe(true);
    await manager.finalize(session, []);
    expect(tabs.remove).toHaveBeenCalledWith(1);
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

  it('claims the foreground tab only when exact expected identity still matches', async () => {
    const tabs = chromeMock();
    const active = { id: 7, url: 'https://example.com/active', title: 'Active', windowId: 1, active: true };
    globalThis.chrome.windows.getLastFocused = vi.fn(async () => ({ id: 1, type: 'normal', tabs: [active] }));
    tabs.get.mockResolvedValue(active);
    globalThis.chrome.debugger.getTargets.mockResolvedValue([{ id: 'page-7', type: 'page', tabId: 7 }]);
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('foreground');
    await expect(manager.claimUserTab(session, { active: true, expectedUrl: 'https://other.test/' })).rejects.toMatchObject({ code: 'claim_identity_mismatch' });
    await expect(manager.claimUserTab(session, { active: true, expectedUrl: 'https://example.com/' })).rejects.toMatchObject({ code: 'claim_identity_mismatch' });
    await expect(manager.claimUserTab(session, { active: true, url: 'https://example.com/' })).rejects.toMatchObject({ code: 'invalid_args' });
    expect(session.leases.size).toBe(0);
    const claimed = await manager.claimUserTab(session, { active: true, expectedUrl: 'https://example.com/active', expectedTitle: 'Active' });
    expect(claimed).toMatchObject({ tabId: 7, page: 'page-7' });
    expect(session.leases.get(7)?.origin).toBe('user');
    expect(tabs.query).not.toHaveBeenCalled();
  });
  it('closes explicit user ids in one operation and reports every unavailable tab', async () => {
    const tabs = chromeMock();
    tabs.query.mockResolvedValue([...([1, 2, 3, 4].map((id) => ({ id, url: `https://example.com/${id}`, windowId: 1 }))), { id: 5, url: 'about:blank', windowId: 1 }]);
    tabs.remove.mockImplementation(async (id) => { if (id === 4) throw new Error('cannot remove'); });
    const manager = new SessionManager(() => {});
    await manager.ready();
    manager.get('mine').leases.set(1, { tabId: 1, origin: 'user', mark: null, claimedAt: Date.now(), state: 'active' });
    manager.get('other').leases.set(3, { tabId: 3, origin: 'user', mark: null, claimedAt: Date.now(), state: 'active' });
    const outcome = await manager.closeUserTabs([1, 2, 2, 3, 4, 5, 99]);
    expect(outcome).toMatchObject({ complete: false, closed: [2, 5], failed: [{ tabId: 1 }, { tabId: 3 }, { tabId: 4 }, { tabId: 99 }] });
    expect(tabs.remove.mock.calls.map(([id]) => id)).toEqual([2, 4, 5]);
  });

  it('returns only popups created by the action source tab', async () => {
    chromeMock();
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('popup');
    session.leases.set(1, { tabId: 1, origin: 'agent', mark: null, claimedAt: Date.now(), state: 'active' });
    const navigationListener = globalThis.chrome.webNavigation.onCreatedNavigationTarget.addListener.mock.calls[0][0];
    const outcome = await manager.withChildTabs(1, async () => {
      navigationListener({ sourceTabId: 3, tabId: 4 });
      navigationListener({ sourceTabId: 1, tabId: 2 });
      return { clicked: true };
    });
    expect(outcome.result).toEqual({ clicked: true });
    expect(outcome.openedTabs).toEqual([expect.objectContaining({ tabId: 2, url: 'https://example.com/' })]);
    expect(session.leases.has(2)).toBe(true);
    expect(session.leases.has(4)).toBe(false);
  });

  it('claims an agent-click popup from a claimed user tab, but leaves manual popups alone', async () => {
    chromeMock();
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('claimed-popup');
    session.leases.set(1, { tabId: 1, origin: 'user', mark: null, claimedAt: Date.now(), state: 'active' });
    const navigationListener = globalThis.chrome.webNavigation.onCreatedNavigationTarget.addListener.mock.calls[0][0];
    navigationListener({ sourceTabId: 1, tabId: 2 });
    await Promise.resolve();
    expect(session.leases.has(2)).toBe(false);
    const outcome = await manager.withChildTabs(1, async () => {
      navigationListener({ sourceTabId: 1, tabId: 3 });
    });
    expect(outcome.openedTabs).toEqual([expect.objectContaining({ tabId: 3 })]);
    expect(session.leases.has(3)).toBe(true);
  });

  it('keeps popup evidence when the action fails after opening it', async () => {
    chromeMock();
    const manager = new SessionManager(() => {});
    await manager.ready();
    const session = manager.get('partial-effect');
    session.leases.set(1, { tabId: 1, origin: 'agent', mark: null, claimedAt: Date.now(), state: 'active' });
    const navigationListener = globalThis.chrome.webNavigation.onCreatedNavigationTarget.addListener.mock.calls[0][0];
    const outcome = await manager.withChildTabs(1, async () => {
      navigationListener({ sourceTabId: 1, tabId: 2 });
      throw new Error('navigation interrupted');
    });
    expect(outcome.error).toMatchObject({ message: 'navigation interrupted' });
    expect(outcome.openedTabs).toEqual([expect.objectContaining({ tabId: 2 })]);
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
