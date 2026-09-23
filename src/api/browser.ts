/**
 * Browser — the connected Chrome: tabs (new/list/get/selected/finalize), the user's own tabs (openTabs/claimTab),
 * session naming, capabilities (cdp, viewport, visibility, webmcp) and the model-facing documentation.
 */
import type { RuntimePage } from '../backends/page-types.js';
import type { ExtensionRuntimePage, UserTabInfo } from '../backends/extension-page.js';
import { ActionError } from './errors.js';
import { buildInstructions, readDoc, type DocContext } from '../docs/manifest.js';
import { Tab } from './tab.js';
import type { SessionContext } from './context.js';

export class Browser {
  constructor(readonly id: 'chrome', readonly type: 'extension', private readonly ctx: SessionContext) {}
  private page(): Promise<RuntimePage> { return this.ctx.rt.getBrowserPage(this.ctx.sessionId); }
  private ext(page: RuntimePage): ExtensionRuntimePage {
    if (!this.ctx.rt.isExtensionPage(page)) throw new ActionError('unsupported_backend', 'This operation needs the Chrome extension backend', 'Run doctor; make sure Chrome is running with the opencli-mcp extension.');
    return page;
  }

  readonly tabs = {
    new: async (url?: string): Promise<Tab> => {
      const page = await this.page();
      if (url && !/^(https?:\/\/|data:text\/html)/i.test(url)) throw new ActionError('invalid_url', 'Only http(s) (or data:text/html) URLs can be opened', 'Pass an absolute http:// or https:// URL.');
      const id = await page.newTab(url); // the extension creates the tab and waits for its first load
      if (!id) throw new ActionError('tab_create_failed', 'Could not create a tab', 'Retry; if it persists run doctor to check the browser bridge.');
      this.ctx.state.finalized = false; // new tabs after a finalize are the session's again
      this.ctx.state.selected = id;
      const tab = new Tab(id, this.ctx, await this.ctx.rt.pageFor(this.ctx.sessionId, id));
      if (url) {
        // another extension may have taken the navigation over (interstitial, redirect to its own page): say so, do not hand out a tab the debugger cannot attach to
        const landed = await tab.url().catch(() => null);
        if (landed && /^(chrome-extension|chrome-error|chrome):/.test(landed)) { await tab.close().catch(() => {}); throw new ActionError('page_not_loaded', `navigation to ${url} ended on ${landed}`, 'Another Chrome extension intercepted this site (redirect or interstitial); disable it for this site or open the page manually and claim the tab.'); }
      }
      return tab;
    },
    list: async (): Promise<Array<{ id: string; url?: string; title?: string; active: boolean; selected: boolean; origin: 'agent' | 'user'; state: 'active' | 'handoff' }>> => {
      const page = await this.page();
      const tabs = await page.tabs() as Array<{ page?: string; url?: string; title?: string; active: boolean; selected: boolean; origin: 'agent' | 'user'; state: 'active' | 'handoff' }>;
      return tabs.filter((t) => t.page).map((t) => ({ id: t.page!, url: t.url, title: t.title, active: t.active, selected: t.selected, origin: t.origin, state: t.state }));
    },
    get: (id: string): Tab => new Tab(id, this.ctx),
    selected: async (): Promise<Tab | undefined> => { const id = this.ctx.state.selected; return id ? new Tab(id, this.ctx) : undefined; },
    finalize: async (opts: { keep?: Array<{ tab: string | Tab; status: 'deliverable' | 'handoff' }> } = {}): Promise<{ closed: string[]; kept: string[]; failed: Array<{ page: string; reason: string }> }> => {
      const page = await this.page();
      const keep = (opts.keep ?? []).map((k) => ({ page: typeof k.tab === 'string' ? k.tab : k.tab.id, status: k.status }));
      const result = this.ctx.rt.isExtensionPage(page) ? await page.finalize(keep) : (await page.closeWindow(), { closed: [], kept: keep.map((k) => k.page), failed: [] });
      for (const id of [...result.closed, ...result.kept]) this.ctx.rt.forgetPage(this.ctx.sessionId, id);
      this.ctx.state.finalized = result.failed.length === 0;
      if (this.ctx.state.finalized) { this.ctx.state.pages.clear(); this.ctx.state.tabLocks.clear(); this.ctx.state.selected = undefined; }
      return result;
    },
  };

  readonly user = {
    openTabs: async (options: { query?: string; limit?: number } = {}): Promise<UserTabInfo[]> => this.ext(await this.page()).userTabs(options),
    /** Claim a user tab by id, or by url/title (unique match) when the id is omitted; url/title with an id act as guards. */
    claimTab: async (tab: { tabId?: number; title?: string; url?: string }): Promise<Tab> => {
      const page = this.ext(await this.page());
      const r = await page.claim(tab);
      this.ctx.state.finalized = false;
      this.ctx.state.selected = r.page;
      return new Tab(r.page, this.ctx, await this.ctx.rt.pageFor(this.ctx.sessionId, r.page));
    },
  };

  async nameSession(name: string): Promise<void> {
    this.ctx.state.name = name;
    const page = await this.page();
    if (this.ctx.rt.isExtensionPage(page)) await page.nameSession(name);
  }

  readonly capabilities = {
    list: async (): Promise<Array<{ id: string; description: string }>> => {
      const base = [
        { id: 'cdp', description: 'Raw Chrome DevTools Protocol on the current tab (allowlisted methods).' },
        { id: 'viewport', description: 'Temporarily override the viewport size for responsive checks; reset when done.' },
        { id: 'webmcp', description: 'Tools the current page registers itself (navigator.modelContext); prefer them over clicking through the DOM.' },
      ];
      if (this.type === 'extension') base.push({ id: 'visibility', description: 'Show or hide the session window to the user. Default: background.' });
      return base;
    },
    get: async (id: string): Promise<Record<string, unknown>> => {
      const page = await this.page();
      this.ctx.state.capabilities.add(id);
      if (id === 'cdp') return { send: (method: string, params?: Record<string, unknown>) => page.cdp(method, params), documentation: () => readDoc('capabilities/cdp') };
      if (id === 'viewport') return { set: ({ width, height }: { width: number; height: number }) => page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }), reset: () => page.cdp('Emulation.clearDeviceMetricsOverride', {}) };
      if (id === 'visibility') { const ext = this.ext(page); return { get: () => ext.getVisibility(), set: (v: boolean) => ext.setVisibility(v), documentation: () => readDoc('capabilities/visibility') }; }
      if (id === 'webmcp') { const sel = await this.tabs.selected(); if (!sel) throw new ActionError('no_tab', 'Open a tab first', 'Call tab_open (or tab_claim a user tab) before using this capability.'); return { list: () => sel.webmcp.list(), call: (name: string, input?: Record<string, unknown>) => sel.webmcp.call(name, input), documentation: () => readDoc('capabilities/webmcp') }; }
      throw new ActionError('unknown_capability', `no capability "${id}"`, 'Use browser.capabilities to see what this backend supports.');
    },
  };

  documentation(): string {
    const ctx: DocContext = { backend: this.type, capabilities: [...this.ctx.state.capabilities] };
    return `${buildInstructions(ctx)}\n\n${readDoc('js-tool') ?? ''}\n\n${readDoc('api-reference') ?? ''}`;
  }
}
