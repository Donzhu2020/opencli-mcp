/**
 * The object model's entry: agent.browsers · sites.<site>.<command>() · recon.discover(tab) · tools.define/compile · session.
 * One surface behind both the typed entry tools and the `js` session.
 */
import type { Runtime } from '../runtime/runtime.js';
import { ActionError } from './errors.js';
import { Policy } from '../runtime/policy.js';
import { discoverEndpoints, type DiscoverResult } from '../recon/discover.js';
import { compileFromTrace, listDefinedTools, type ToolDefinition } from '../sites/define.js';
import { readDoc } from '../docs/manifest.js';
import { Tab } from './tab.js';
import { Browser } from './browser.js';
import type { SessionContext } from './context.js';

export interface AgentApi {
  agent: { browsers: { getDefault(): Promise<Browser> }; browser: Browser; documentation: { get(name: string): string | null } };
  sites: Record<string, unknown> & { search(q: string, limit?: number): unknown; list(): unknown; enable(site: string, opts?: { write?: boolean }): { site: string; tools: string[] }; disable(site: string): boolean; run(site: string, name: string, args?: Record<string, unknown>): Promise<unknown> };
  recon: { discover(tab: Tab, opts?: Parameters<typeof discoverEndpoints>[1]): Promise<DiscoverResult> };
  tools: { define(def: ToolDefinition | (Omit<ToolDefinition, 'func'> & { func?: string | ((ctx: Record<string, unknown>) => unknown) })): Promise<{ file: string; site: string; name: string }>; compile(opts: Parameters<typeof compileFromTrace>[2]): ToolDefinition; list(): ReturnType<typeof listDefinedTools>; remove(site: string, name: string): boolean };
  session: { id: string; /** approve a website host after the user agreed (needs_origin_approval), for this run */ allowOrigin(host: string): { host: string }; trace(): unknown[]; clearTrace(): void; };
}

export function createAgentApi(rt: Runtime, sessionId: string): AgentApi {
  const state = rt.session(sessionId);
  const ctx: SessionContext = { rt, sessionId, state };
  // One user, one Chrome — there is no browser fleet to route among; getDefault is the single accessor.
  const getDefault = async (): Promise<Browser> => {
    if (rt.backend() !== 'extension') throw new ActionError('browser_unavailable', 'No browser backend is connected', 'Run doctor. Site commands with strategy `public` still work without a browser.');
    return new Browser('chrome', 'extension', ctx);
  };

  const siteBase = {
    search: (q: string, limit = 20) => rt.registry.search(q, limit),
    list: () => rt.registry.sites(),
    enable: (site: string, opts: { write?: boolean } = {}) => {
      if (!rt.registry.has(site)) throw new ActionError('unknown_site', `no site "${site}"`, 'Use sites.search() to find the right name.');
      state.enabledSites.set(site, { write: Boolean(opts.write) });
      rt.emit('tools-changed', { site });
      const cmds = rt.registry.commands(site).filter((c) => opts.write || c.access === 'read');
      const tools = cmds.map((c) => `${site}_${c.name}`.replace(/[^A-Za-z0-9_-]/g, '_'));
      return { site, tools, commands: cmds.map((c) => ({ tool: `${site}_${c.name}`.replace(/[^A-Za-z0-9_-]/g, '_'), description: c.description, access: c.access, strategy: String(c.strategy ?? 'public'), args: c.args.map((a) => `${a.name}${a.required ? '*' : ''}${a.type ? `:${a.type}` : ''}`) })), note: cmds.some((c) => c.browser) ? 'Browser-backed commands reuse your logged-in Chrome session in a background adapter tab.' : undefined };
    },
    disable: (site: string) => { const ok = state.enabledSites.delete(site); if (ok) rt.emit('tools-changed', { site }); return ok; },
    run: async (site: string, name: string, args: Record<string, unknown> = {}) => {
      const { confirm, ...rest } = args as { confirm?: boolean } & Record<string, unknown>;
      const cmd = await rt.registry.resolve(site, name);
      if (cmd.access === 'write') Policy.throwIfDenied(rt.policy.checkWrite(`${site}/${name}`, Boolean(confirm)));
      const r = await rt.runSite(sessionId, site, name, rest);
      if (!r.ok) throw new ActionError(r.error.code, r.error.message, r.error.hint, { site, command: name , ...(r.error.details && { details: r.error.details }) });
      return r.rows ?? r.value;
    },
  };
  const sites = new Proxy(siteBase as AgentApi['sites'], {
    get(target, prop) {
      if (typeof prop !== 'string' || prop in target) return Reflect.get(target, prop);
      if (!rt.registry.has(prop)) return undefined;
      return new Proxy({}, { get: (_t, cmd) => typeof cmd === 'string' ? (args: Record<string, unknown> = {}) => siteBase.run(prop, cmd.replace(/_/g, '-'), args) : undefined });
    },
    has(target, prop) { return typeof prop === 'string' && (prop in target || rt.registry.has(prop)); },
  });

  return {
    agent: {
      browsers: { getDefault },
      // The single default browser, eagerly available (one user, one Chrome) so `browser.tabs/user/...` works in js
      // without a bootstrap line; ops throw browser_unavailable at call time when Chrome isn't connected.
      browser: new Browser('chrome', 'extension', ctx),
      documentation: { get: (name: string) => readDoc(name) },
    },
    sites,
    recon: { discover: async (tab: Tab, opts) => { const log = await tab.network.read({ limit: 2000 }); return tab.use((page) => discoverEndpoints(page, { ...opts, network: log.entries as Array<Record<string, unknown>> })); } },
    tools: {
      // from js the agent may pass the function it just ran; its source is what gets frozen
      define: (def: ToolDefinition | (Omit<ToolDefinition, 'func'> & { func?: string | ((ctx: Record<string, unknown>) => unknown) })) => rt.defineTool({ ...def, func: typeof def.func === 'function' ? def.func.toString() : def.func } as ToolDefinition),
      compile: (opts) => compileFromTrace(state.trace.events, state.netEvidence, opts),
      list: () => listDefinedTools(),
      remove: (site: string, name: string) => rt.removeTool(site, name),
    },
    session: {
      id: sessionId,
      allowOrigin: (host: string) => { rt.policy.allowHost(host); return { host }; },
      trace: () => state.trace.events,
      clearTrace: () => { state.trace.clear(); state.netEvidence.length = 0; state.netLog.clear(); },
    },
  };
}
