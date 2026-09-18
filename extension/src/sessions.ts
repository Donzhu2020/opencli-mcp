/**
 * Sessions & tab leases — tabs are the user's property.
 * A session ⇄ one named Chrome tab group. Agent-created tabs (and popups they spawn) join the
 * group in the background, muted until looked at. User tabs are claimed fail-closed
 * (tabId + title + url) and never moved or closed. finalize() decides what the user keeps.
 */
import type { BrowserEvent } from '../../src/protocol.js';
import * as executor from './cdp';
import * as identity from './identity';

export type Origin = 'agent' | 'user';
export type Mark = 'deliverable' | 'handoff' | null;
export type Badge = 'active' | 'deliverable' | 'handoff' | null;

export interface Lease { tabId: number; origin: Origin; mark: Mark; title?: string; url?: string; claimedAt: number; state: 'active' | 'handoff' }
export interface Session {
  key: string;
  surface: 'browser' | 'adapter';
  name: string | null;
  groupId: number | null;
  windowId: number | null;
  leases: Map<number, Lease>;
  preferredTabId: number | null;
  visible: boolean;
  lifecycle: 'ephemeral' | 'persistent';
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastActivity: number;
}

type GroupColor = chrome.tabGroups.TabGroup['color'];
const GROUP_COLORS: GroupColor[] = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const IDLE_MS: Record<Session['surface'], number> = { browser: 60 * 60_000, adapter: 10 * 60_000 };
const CONTENT_FILE = 'content/cursor.js';

export class SessionError extends Error { constructor(readonly code: string, message: string, readonly hint?: string) { super(message); } }

function isHttp(url?: string): boolean { return Boolean(url && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:text/html'))); }

const STORE_KEY = 'opencli_mcp_sessions_v1';
type StoredSession = Omit<Session, 'leases' | 'idleTimer'> & { leases: Lease[] };

export class SessionManager {
  readonly sessions = new Map<string, Session>();
  private cursorSeq = 0;
  private restored: Promise<void> | null = null;

  /** Leases live in chrome.storage.session: they survive a service-worker restart but not a browser exit. */
  private persist(): void {
    const data: StoredSession[] = [...this.sessions.values()].map(({ leases, idleTimer: _t, ...rest }) => ({ ...rest, leases: [...leases.values()] }));
    void chrome.storage.session.set({ [STORE_KEY]: data }).catch(() => {});
  }
  private restore(): Promise<void> {
    if (!this.restored) this.restored = (async () => {
      try {
        const stored = (await chrome.storage.session.get(STORE_KEY))?.[STORE_KEY] as StoredSession[] | undefined;
        for (const st of stored ?? []) {
          if (this.sessions.has(st.key)) continue;
          const leases = new Map<number, Lease>();
          for (const l of st.leases) { try { await chrome.tabs.get(l.tabId); leases.set(l.tabId, l); } catch { /* tab gone */ } }
          if (leases.size === 0) continue;
          this.sessions.set(st.key, { ...st, leases, idleTimer: null });
        }
      } catch { /* storage unavailable */ }
    })();
    return this.restored;
  }
  constructor(private readonly emit: (e: BrowserEvent) => void) {
    chrome.tabs.onRemoved.addListener((tabId) => this.onTabRemoved(tabId));
    chrome.tabs.onActivated.addListener(({ tabId }) => { void this.unmuteIfOurs(tabId); });
    chrome.tabGroups.onRemoved.addListener((g) => { for (const s of this.sessions.values()) if (s.groupId === g.id) s.groupId = null; });
    chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => { void this.onChildTab(d.sourceTabId, d.tabId); });
    chrome.windows.onRemoved.addListener((windowId) => { if (this.adapterWindowId === windowId) this.adapterWindowId = null; for (const s of this.sessions.values()) if (s.windowId === windowId) { s.windowId = null; s.groupId = null; } });
    chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'complete') { const s = this.ownerOf(tabId); const lease = s?.leases.get(tabId); if (lease) void this.badge(tabId, lease.state === 'handoff' ? 'handoff' : 'active'); } });
    void this.restore();
  }

  async ready(): Promise<void> { await this.restore(); }

  get(key: string, surface: 'browser' | 'adapter' = 'browser', lifecycle?: 'ephemeral' | 'persistent'): Session {
    let s = this.sessions.get(key);
    if (!s) {
      s = { key, surface, name: null, groupId: null, windowId: null, leases: new Map(), preferredTabId: null, visible: false, lifecycle: lifecycle ?? (surface === 'adapter' ? 'ephemeral' : 'persistent'), idleTimer: null, lastActivity: Date.now() };
      this.sessions.set(key, s);
    }
    if (lifecycle) s.lifecycle = lifecycle;
    return s;
  }
  touch(s: Session): void {
    s.lastActivity = Date.now();
    if (s.idleTimer) clearTimeout(s.idleTimer);
    const ms = IDLE_MS[s.surface];
    s.idleTimer = setTimeout(() => { void this.finalize(s, []).catch(() => {}); }, ms);
  }
  /** Leases whose tabs still exist, in insertion order (the same order `tabs list` reports). */
  async liveLeases(s: Session): Promise<Lease[]> {
    const out: Lease[] = [];
    for (const l of s.leases.values()) { try { await chrome.tabs.get(l.tabId); out.push(l); } catch { s.leases.delete(l.tabId); } }
    return out;
  }
  ownerOf(tabId: number): Session | null { for (const s of this.sessions.values()) if (s.leases.has(tabId)) return s; return null; }

  private async pickWindow(): Promise<number> {
    const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    if (focused?.id !== undefined && focused.type === 'normal') return focused.id;
    const all = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (all[0]?.id !== undefined) return all[0].id;
    const w = await chrome.windows.create({ focused: false, type: 'normal', url: 'about:blank' });
    if (!w?.id) throw new SessionError('window_create_failed', 'Could not create a browser window');
    return w.id;
  }

  private colorFor(key: string): GroupColor {
    let h = 0; for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return GROUP_COLORS[h % GROUP_COLORS.length];
  }

  private async ensureGroup(s: Session, tabId: number): Promise<void> {
    if (s.surface === 'adapter') return; // background adapter runs stay out of the user's tab strip folders
    const title = s.name ?? 'opencli-mcp';
    if (s.groupId !== null) {
      try { await chrome.tabs.group({ groupId: s.groupId, tabIds: [tabId] }); return; } catch { s.groupId = null; }
    }
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    s.groupId = groupId;
    await chrome.tabGroups.update(groupId, { title, color: this.colorFor(s.key) }).catch(() => {});
  }

  /** Background adapter runs get their own minimized window so they never clutter the user's tab strip. */
  private adapterWindowId: number | null = null;
  private async pickAdapterWindow(): Promise<number> {
    if (this.adapterWindowId !== null) { try { await chrome.windows.get(this.adapterWindowId); return this.adapterWindowId; } catch { this.adapterWindowId = null; } }
    const w = await chrome.windows.create({ focused: false, type: 'normal', url: 'about:blank', state: 'minimized' });
    if (!w?.id) throw new SessionError('window_create_failed', 'Could not create the adapter window');
    this.adapterWindowId = w.id;
    return w.id;
  }

  async createTab(s: Session, url?: string): Promise<{ tabId: number; page: string; tab: chrome.tabs.Tab }> {
    const pick = async () => s.surface === 'adapter' && !s.visible ? this.pickAdapterWindow() : this.pickWindow();
    let windowId = s.windowId ?? await pick();
    const target = url && isHttp(url) ? url : 'about:blank';
    // Register the load watcher before the tab exists so a fast (cached) load is never missed.
    let createdId = -1; let loaded = false; let navError: string | null = null;
    const loadedP = new Promise<void>((resolve) => {
      const done = () => { chrome.tabs.onUpdated.removeListener(listener); chrome.webNavigation.onErrorOccurred.removeListener(onErr); resolve(); };
      const listener = (id: number, info: chrome.tabs.OnUpdatedInfo) => { if (id === createdId && info.status === 'complete') { loaded = true; done(); } };
      const onErr = (d: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => { if (d.tabId === createdId && d.frameId === 0) { navError = d.error; done(); } };
      chrome.tabs.onUpdated.addListener(listener);
      chrome.webNavigation.onErrorOccurred.addListener(onErr);
      setTimeout(done, 15_000);
    });
    let tab: chrome.tabs.Tab;
    try { tab = await chrome.tabs.create({ windowId, url: target, active: s.visible }); }
    catch { s.windowId = null; s.groupId = null; windowId = await pick(); tab = await chrome.tabs.create({ windowId, url: target, active: s.visible }); }
    createdId = tab.id!;
    if (target !== 'about:blank') {
      const t = await chrome.tabs.get(createdId).catch(() => null);
      if (t?.status === 'complete' && t.url) loaded = true; else await loadedP;
      tab = await chrome.tabs.get(createdId).catch(() => tab);
      if (navError) throw new SessionError('page_not_loaded', `navigation to ${target} failed: ${navError}`, 'The browser blocked or could not reach the URL (policy, offline, DNS, or an extension). Check chrome://policy and the network.');
      if (!loaded) console.warn(`[opencli-mcp] tab ${createdId} did not finish loading ${target} within 15s (url=${tab.url ?? ''})`);
    }
    const tabId = tab.id!;
    s.windowId = tab.windowId;
    if (!s.visible) await chrome.tabs.update(tabId, { muted: true }).catch(() => {});
    await this.ensureGroup(s, tabId);
    s.leases.set(tabId, { tabId, origin: 'agent', mark: null, url: tab.url, title: tab.title, claimedAt: Date.now(), state: 'active' });
    s.preferredTabId = tabId;
    const page = await identity.resolveTargetId(tabId).catch(() => String(tabId));
    void this.badge(tabId, 'active');
    this.emit({ kind: 'tab_created', session: s.key, page, tabId, url: tab.url, title: tab.title, origin: 'agent' });
    this.touch(s);
    this.persist();
    return { tabId, page, tab };
  }

  async listUserTabs(): Promise<Array<{ tabId: number; title?: string; url?: string; windowId: number; active: boolean; groupId?: number; lastAccessed?: number }>> {
    const tabs = await chrome.tabs.query({ windowType: 'normal' });
    return tabs.filter((t) => t.id !== undefined && isHttp(t.url) && !this.ownerOf(t.id))
      .sort((a, b) => ((b as { lastAccessed?: number }).lastAccessed ?? 0) - ((a as { lastAccessed?: number }).lastAccessed ?? 0))
      .map((t) => ({ tabId: t.id!, title: t.title, url: t.url, windowId: t.windowId, active: Boolean(t.active), groupId: t.groupId && t.groupId > 0 ? t.groupId : undefined, lastAccessed: (t as { lastAccessed?: number }).lastAccessed }));
  }

  /**
   * Claim like Codex's claimTab(tab | id): the tab id alone is enough. url/title are optional matchers — a url matches by
   * exact value or prefix, a title by case-insensitive substring — used as guards when an id is given, or to find the tab
   * when it is not (then the match must be unique; ambiguity fails closed with the candidates).
   */
  async claimUserTab(s: Session, claim: { tabId?: number; title?: string; url?: string }): Promise<{ tabId: number; page: string; tab: chrome.tabs.Tab }> {
    const urlOk = (u?: string) => claim.url === undefined || (u !== undefined && (u === claim.url || u.startsWith(claim.url)));
    const titleOk = (t?: string) => claim.title === undefined || (t !== undefined && t.toLowerCase().includes(claim.title.toLowerCase()));
    let tab: chrome.tabs.Tab;
    if (claim.tabId === undefined) {
      if (claim.url === undefined && claim.title === undefined) throw new SessionError('claim_not_allowed', 'claim needs a tabId, or a url/title to find the tab', 'List user tabs first (tab_list user:true).');
      const candidates = (await this.listUserTabs()).filter((t) => urlOk(t.url) && titleOk(t.title));
      if (candidates.length === 0) throw new SessionError('claim_not_found', `no user tab matches ${JSON.stringify({ url: claim.url, title: claim.title })}`, 'List user tabs and claim by tabId.');
      if (candidates.length > 1) throw new SessionError('claim_ambiguous', `${candidates.length} user tabs match; claim by tabId: ${candidates.map((c) => `${c.tabId} "${c.title}" ${c.url}`).join('; ')}`, 'Pass the tabId of the intended tab.');
      tab = await chrome.tabs.get(candidates[0].tabId);
    } else {
      try { tab = await chrome.tabs.get(claim.tabId); } catch { throw new SessionError('claim_identity_mismatch', `Tab ${claim.tabId} no longer exists`, 'List user tabs again and claim a current one.'); }
      if (!urlOk(tab.url) || !titleOk(tab.title)) throw new SessionError('claim_identity_mismatch', `Tab ${claim.tabId} does not match the given url/title (now "${tab.title}" ${tab.url})`, 'Do not claim a different tab silently; list again and confirm, or claim by tabId alone.');
    }
    const tabId = tab.id!;
    if (!isHttp(tab.url)) throw new SessionError('claim_not_allowed', 'Only http(s) tabs can be claimed');
    const owner = this.ownerOf(tabId);
    if (owner && owner !== s) throw new SessionError('already_claimed', `Tab ${tabId} belongs to session ${owner.key}`);
    s.windowId = s.windowId ?? tab.windowId;
    s.leases.set(tabId, { tabId: tabId, origin: 'user', mark: null, url: tab.url, title: tab.title, claimedAt: Date.now(), state: 'active' });
    s.preferredTabId = tabId;
    const page = await identity.resolveTargetId(tabId).catch(() => String(tabId));
    void this.badge(tabId, 'active');
    this.emit({ kind: 'tab_acquired', session: s.key, page, tabId: tabId, url: tab.url, title: tab.title, origin: 'user' });
    this.touch(s);
    this.persist();
    return { tabId: tabId, page, tab };
  }

  /** Resolve the tab a page-scoped command targets; create one when the session has none. */
  async resolveTab(s: Session, page?: string, initialUrl?: string): Promise<number> {
    this.touch(s);
    if (page) {
      let tabId: number;
      try { tabId = await identity.resolveTabId(page); } catch { throw new SessionError('stale_page', `stale page identity ${page}`, 'The tab was closed or navigated away; open or claim a fresh tab.'); }
      if (!s.leases.has(tabId)) {
        const owner = this.ownerOf(tabId);
        if (owner && owner !== s) throw new SessionError('page_not_in_session', `page ${page} belongs to session ${owner.key}`);
        // unknown lease (e.g. state lost): adopt fail-safe as a user tab — it will be released, never closed
        s.leases.set(tabId, { tabId, origin: 'user', mark: null, claimedAt: Date.now(), state: 'active' });
        this.persist();
      }
      s.preferredTabId = tabId;
      return tabId;
    }
    if (s.preferredTabId !== null) {
      try { await chrome.tabs.get(s.preferredTabId); return s.preferredTabId; } catch { s.leases.delete(s.preferredTabId); s.preferredTabId = null; }
    }
    for (const lease of s.leases.values()) if (lease.state === 'active') { s.preferredTabId = lease.tabId; return lease.tabId; }
    return (await this.createTab(s, initialUrl)).tabId;
  }

  async nameSession(s: Session, name: string): Promise<void> {
    s.name = name;
    if (s.groupId !== null) await chrome.tabGroups.update(s.groupId, { title: name }).catch(() => {});
    this.persist();
  }

  mark(s: Session, tabId: number, mark: Mark): void {
    const lease = s.leases.get(tabId);
    if (!lease) throw new SessionError('page_not_in_session', `tab ${tabId} is not part of session ${s.key}`);
    lease.mark = mark;
    this.persist();
  }

  async finalize(s: Session, keep: Array<{ page: string; status: 'deliverable' | 'handoff' }>): Promise<{ closed: string[]; kept: string[] }> {
    const closed: string[] = []; const kept: string[] = [];
    const keepByTab = new Map<number, 'deliverable' | 'handoff'>();
    for (const k of keep) { try { keepByTab.set(await identity.resolveTabId(k.page), k.status); } catch { /* gone */ } }
    for (const lease of [...s.leases.values()]) {
      const status = keepByTab.get(lease.tabId) ?? lease.mark ?? null;
      const page = await identity.resolveTargetId(lease.tabId).catch(() => String(lease.tabId));
      await executor.detach(lease.tabId).catch(() => {});
      if (status === 'handoff') {
        lease.state = 'handoff'; lease.mark = 'handoff';
        await this.badge(lease.tabId, 'handoff'); kept.push(page); continue;
      }
      if (status === 'deliverable') {
        await this.badge(lease.tabId, 'deliverable');
        if (lease.origin === 'agent') await chrome.tabs.ungroup(lease.tabId).catch(() => {});
        await chrome.tabs.update(lease.tabId, { muted: false }).catch(() => {});
        s.leases.delete(lease.tabId); kept.push(page); continue;
      }
      await this.badge(lease.tabId, null);
      s.leases.delete(lease.tabId);
      if (lease.origin === 'agent') { await chrome.tabs.remove(lease.tabId).catch(() => {}); closed.push(page); }
      else { await chrome.tabs.update(lease.tabId, { muted: false }).catch(() => {}); kept.push(page); }
      identity.evictTab(lease.tabId);
    }
    s.preferredTabId = null;
    if (s.leases.size === 0) { s.groupId = null; if (s.idleTimer) clearTimeout(s.idleTimer); this.sessions.delete(s.key); }
    this.persist();
    this.emit({ kind: 'session_released', session: s.key, reason: 'finalize' });
    return { closed, kept };
  }

  async setVisibility(s: Session, visible: boolean): Promise<void> {
    s.visible = visible;
    if (visible) {
      if (s.preferredTabId !== null) await chrome.tabs.update(s.preferredTabId, { active: true, muted: false }).catch(() => {});
      if (s.windowId !== null) await chrome.windows.update(s.windowId, { focused: true, state: 'normal' }).catch(() => {});
    }
  }

  private onTabRemoved(tabId: number): void {
    for (const s of this.sessions.values()) {
      if (!s.leases.delete(tabId)) continue;
      if (s.preferredTabId === tabId) s.preferredTabId = null;
      void identity.resolveTargetId(tabId).catch(() => undefined).then((page) => { identity.evictTab(tabId); this.emit({ kind: 'tab_closed', session: s.key, page, tabId }); });
      this.persist();
    }
  }
  private async unmuteIfOurs(tabId: number): Promise<void> {
    if (!this.ownerOf(tabId)) return;
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t?.mutedInfo?.muted && t.mutedInfo.reason === 'extension') await chrome.tabs.update(tabId, { muted: false }).catch(() => {});
  }
  private async onChildTab(sourceTabId: number, childId: number): Promise<void> {
    const s = this.ownerOf(sourceTabId);
    if (!s || s.leases.has(childId)) return;
    if (s.leases.get(sourceTabId)?.origin !== 'agent') return; // a user clicking in their own claimed tab keeps their tabs
    const tab = await chrome.tabs.get(childId).catch(() => null);
    if (!tab) return;
    s.leases.set(childId, { tabId: childId, origin: 'agent', mark: null, url: tab.url, title: tab.title, claimedAt: Date.now(), state: 'active' });
    if (!s.visible) await chrome.tabs.update(childId, { muted: true, active: false }).catch(() => {});
    await this.ensureGroup(s, childId);
    const page = await identity.resolveTargetId(childId).catch(() => String(childId));
    void this.badge(childId, 'active');
    this.emit({ kind: 'tab_created', session: s.key, page, tabId: childId, url: tab.url, title: tab.title, origin: 'agent' });
    this.persist();
  }

  // ── human visibility: content script for cursor overlay + favicon badge ──
  private async ensureContent(tabId: number): Promise<boolean> {
    try { const r = await chrome.tabs.sendMessage(tabId, { type: 'opencli:ping' }); if (r?.ok) return true; } catch { /* inject */ }
    try { await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_FILE], injectImmediately: true }); return true; } catch { return false; }
  }
  async badge(tabId: number, badge: Badge): Promise<void> {
    try { if (await this.ensureContent(tabId)) await chrome.tabs.sendMessage(tabId, { type: 'opencli:badge', badge }); } catch { /* not injectable (chrome://, pdf) */ }
  }
  async cursor(tabId: number, x: number, y: number, waitForArrival: boolean, timeoutMs = 1200): Promise<boolean> {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !tab.active) return false; // only animate where the user can see it
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (!win || win.state === 'minimized') return false;
    if (!(await this.ensureContent(tabId))) return false;
    const seq = ++this.cursorSeq;
    const p = chrome.tabs.sendMessage(tabId, { type: 'opencli:cursor', x, y, seq, animate: waitForArrival });
    if (!waitForArrival) return true;
    const result = await Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
    return Boolean(result && (result as { arrived?: boolean }).arrived);
  }
}
