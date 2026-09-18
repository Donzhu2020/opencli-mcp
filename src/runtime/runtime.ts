/**
 * Runtime — the resident kernel: site registry, per-MCP-session state, page backends, traces.
 * Lives inside the Chrome-spawned host (extension backend) or embedded in the stdio launcher
 * (browser-less: only `public` site commands work until Chrome connects).
 */
import { EventEmitter } from 'node:events';
import type { ExtensionBridge } from '../host/bridge.js';
import type { BrowserEvent } from '../protocol.js';
import { SiteRegistry } from '../sites/registry.js';
import { runSiteCommand, type CommandRunResult, type CommandRunError, type PageProvider } from '../sites/executor.js';
import { saveTool, deleteTool, listDefinedTools, ensureToolsDir, type ToolDefinition } from '../sites/define.js';
import { createExtensionPage, type ExtensionRuntimePage } from '../backends/extension-page.js';
import type { RuntimePage } from '../backends/page-types.js';
import { TraceRecorder } from './trace.js';
import { JsSession } from '../mcp/js-session.js';
import { opencliVersion } from '../lib/opencli.js';
import { emitHook } from '../sites/hooks.js';
import { Policy } from './policy.js';
import { Tab, createAgentApi, type AgentApi } from '../api/agent.js';

export type Backend = 'extension' | 'none';

export interface RuntimeOptions {
  bridge?: ExtensionBridge | null;
  policy?: import('./policy.js').PolicyConfig;
  sites?: string[];
  sitesWrite?: string[];
  cursor?: boolean;
  log?: (msg: string) => void;
}

export interface SessionState {
  id: string;
  name?: string;
  createdAt: number;
  trace: TraceRecorder;
  browserPage?: RuntimePage;
  browserPagePromise?: Promise<RuntimePage>;
  /** One page object per tab (same bridge, own identity); the session page above carries no tab and serves session-scope calls. */
  pages: Map<string, RuntimePage>;
  /** Per-tab serialization of page operations. */
  tabLocks: Map<string, Promise<void>>;
  /** The tab the agent used most recently (what `browser.tabs.selected()` returns). */
  selected?: string;
  enabledSites: Map<string, { write: boolean }>;
  capabilities: Set<string>;
  docsRead: Set<string>;
  js?: JsSession;
  lastObserve: Map<string, string>;
  /** Network entries seen per tab, with monotonically increasing sequence numbers for cursor-based reads. */
  netLog: Map<string, { seq: number; entries: Array<Record<string, unknown> & { seq: number }>; seen: Set<string> }>;
  finalized: boolean;
}

export interface DoctorReport {
  backend: Backend;
  extension: { connected: boolean; version: string | null; contextId?: string };
  opencliVersion: string;
  sites: number;
  commands: number;
  definedTools: number;
  sessions: number;
  cursor: boolean;
}

export interface RuntimeEvents {
  'browser-event': [BrowserEvent];
  'tools-changed': [{ site?: string }];
  'session-closed': [string];
  log: [string];
}

export class Runtime extends EventEmitter<RuntimeEvents> implements PageProvider {
  readonly registry = new SiteRegistry();
  readonly sessions = new Map<string, SessionState>();
  private readonly adapterPages = new Map<string, Promise<RuntimePage>>();
  private readonly siteApis = new Map<string, AgentApi>();
  bridge: ExtensionBridge | null;
  readonly cursorEnabled: boolean;
  readonly policy: Policy;
  readonly configSites: string[];
  readonly configSitesWrite: string[];
  readonly startedAt = Date.now();

  constructor(opts: RuntimeOptions = {}) {
    super();
    this.bridge = opts.bridge ?? null;
    this.cursorEnabled = opts.cursor ?? true;
    this.policy = new Policy(opts.policy);
    this.configSites = opts.sites ?? [];
    this.configSitesWrite = opts.sitesWrite ?? [];
    if (opts.log) this.on('log', opts.log);
    this.bridge?.on('event', (e) => this.emit('browser-event', e));
    this.bridge?.on('close', () => { this.adapterPages.clear(); for (const s of this.sessions.values()) { s.browserPage = undefined; s.pages.clear(); } });
  }

  async init(): Promise<void> {
    await this.registry.load();
    try { ensureToolsDir(); } catch (err) { this.emit('log', `tools dir unavailable: ${(err as Error).message}`); }
    await emitHook('onStartup', { command: '__startup__', args: {} });
  }

  backend(): Backend {
    if (this.bridge?.connected) return 'extension';
    return 'none';
  }
  browserAvailable(): boolean { return this.backend() !== 'none'; }

  session(id: string): SessionState {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, createdAt: Date.now(), trace: new TraceRecorder(), pages: new Map(), tabLocks: new Map(), enabledSites: new Map(), capabilities: new Set(), docsRead: new Set(), lastObserve: new Map(), netLog: new Map(), finalized: false };
      this.sessions.set(id, s);
    }
    return s;
  }

  /** One interactive browser page per MCP session (tabs are page identities on it). */
  async getBrowserPage(sessionId: string): Promise<RuntimePage> {
    const s = this.session(sessionId);
    if (s.browserPage) return s.browserPage;
    if (!s.browserPagePromise) {
      s.browserPagePromise = this.createPage({ session: `mcp:${sessionId}`, surface: 'browser', windowMode: 'background' }).then((p) => { s.browserPage = p; return p; }).finally(() => { s.browserPagePromise = undefined; });
    }
    return s.browserPagePromise;
  }

  /** The page object bound to one tab of a session: commands carry the tab's identity, nothing is switched or shared. */
  async pageFor(sessionId: string, pageId: string): Promise<RuntimePage> {
    const s = this.session(sessionId);
    const existing = s.pages.get(pageId);
    if (existing) return existing;
    const page = await this.createPage({ session: `mcp:${sessionId}`, surface: 'browser', windowMode: 'background', page: pageId });
    s.pages.set(pageId, page);
    return page;
  }
  forgetPage(sessionId: string, pageId: string): void { const s = this.sessions.get(sessionId); s?.pages.delete(pageId); s?.tabLocks.delete(pageId); if (s?.selected === pageId) s.selected = undefined; }

  /** Background adapter page per site (shared by all MCP sessions), like OpenCLI's site sessions. */
  async getAdapterPage(site: string, opts: { siteSession: 'ephemeral' | 'persistent'; windowMode: 'foreground' | 'background'; navigateTo?: string }): Promise<RuntimePage> {
    const key = `site:${site}`;
    let p = this.adapterPages.get(key);
    if (!p) {
      p = this.createPage({ session: key, surface: 'adapter', siteSession: opts.siteSession, windowMode: opts.windowMode });
      this.adapterPages.set(key, p);
      p.catch(() => this.adapterPages.delete(key));
    }
    return p;
  }

  private async createPage(opts: { session: string; surface: 'browser' | 'adapter'; siteSession?: 'ephemeral' | 'persistent'; windowMode?: 'foreground' | 'background'; page?: string }): Promise<RuntimePage> {
    const backend = this.backend();
    if (backend === 'extension' && this.bridge) return createExtensionPage(this.bridge, { ...opts, contextId: this.bridge.contextId });
    throw Object.assign(new Error('No browser backend is connected'), { code: 'browser_unavailable', hint: 'Run `opencli-mcp doctor`. Chrome with the opencli-mcp extension must be running.' });
  }

  /** Frozen tools run on the exploration object model: a Tab bound to the adapter page, plus sites/recon/page. */
  async toolContext(page: RuntimePage, site: string): Promise<Record<string, unknown>> {
    const sessionId = `site:${site}`;
    let api = this.siteApis.get(sessionId);
    if (!api) { api = createAgentApi(this, sessionId); this.siteApis.set(sessionId, api); }
    const state = this.session(sessionId);
    const tab = new Tab(page.getActivePage() ?? 'adapter', { rt: this, sessionId, state }, page);
    return { tab, page, sites: api.sites, recon: api.recon };
  }

  isExtensionPage(page: RuntimePage): page is ExtensionRuntimePage { return typeof (page as ExtensionRuntimePage).claim === 'function'; }

  async runSite(sessionId: string | null, site: string, name: string, args: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<CommandRunResult | CommandRunError> {
    const cmd = await this.registry.resolve(site, name);
    const r = await runSiteCommand(this, cmd, args, opts);
    if (sessionId) this.session(sessionId).trace.record({ kind: 'site', site, name, ok: r.ok, elapsedMs: r.elapsedMs });
    return r;
  }

  async defineTool(def: ToolDefinition): Promise<{ file: string; site: string; name: string }> {
    const saved = await saveTool(def);
    this.emit('tools-changed', { site: def.site });
    return saved;
  }
  removeTool(site: string, name: string): boolean {
    const ok = deleteTool(site, name);
    if (ok) this.emit('tools-changed', { site });
    return ok;
  }

  async closeSession(id: string, opts: { finalize?: boolean } = {}): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    const page = s.browserPage;
    if (page && opts.finalize !== false && !s.finalized) {
      try {
        if (this.isExtensionPage(page)) await page.finalize([]);
        else await page.closeWindow();
      } catch (err) { this.emit('log', `finalize on close failed: ${(err as Error).message}`); }
    }
    this.emit('session-closed', id);
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.closeSession(id);
  }

  doctor(): DoctorReport {
    const all = this.registry.all();
    return {
      backend: this.backend(),
      extension: { connected: Boolean(this.bridge?.connected), version: this.bridge?.extensionVersion ?? null, contextId: this.bridge?.contextId },
      opencliVersion,
      sites: new Set(all.map((c) => c.site)).size,
      commands: all.length,
      definedTools: listDefinedTools().length,
      sessions: this.sessions.size,
      cursor: this.cursorEnabled,
    };
  }
}
