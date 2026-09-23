/**
 * MCP server per session: typed core tools, dynamic site tools, the `js` code-mode tool,
 * resources (docs, sites) and prompts — all backed by the same object model.
 */
import { McpServer, ResourceTemplate, type RegisteredTool } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Runtime } from '../runtime/runtime.js';
import { createAgentApi, Tab, type AgentApi, type ActAction } from '../api/agent.js';
import { ActionError, errorEnvelope } from '../api/errors.js';
import { JsSession, safeStringify } from './js-session.js';
import { buildInstructions, listDocs, readDoc, type DocContext } from '../docs/manifest.js';
import { argsToShape, coerceArgs } from '../sites/schema.js';
import { listDefinedTools } from '../sites/define.js';
import { checkActInput, checkExpect } from './act-input.js';

type Content = Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
type ToolResult = { content: Content; structuredContent?: Record<string, unknown>; isError?: boolean };

const targetSchema = z.object({
  ref: z.string().optional().describe('eN ref from tab_observe. Do not combine with another locator'),
  selector: z.string().optional().describe('Playwright selector. Do not combine with ref, role, or x/y'),
  within: z.string().optional().describe('scope: selector of a container or an eN ref; the target is resolved inside it'),
  nth: z.number().int().optional(),
  role: z.string().optional().describe('ARIA role, e.g. button, link, textbox'),
  name: z.string().optional().describe('accessible name (with role)'),
  label: z.string().optional().describe('form label text'),
  text: z.string().optional().describe('visible text'),
  testid: z.string().optional().describe('data-testid'),
  x: z.number().optional().describe('viewport x; y is required with it'),
  y: z.number().optional(),
  frame: z.union([z.string(), z.number().int(), z.array(z.union([z.string(), z.number().int()]))]).optional().describe('iframe(s) to enter first, outermost first'),
}).strict().describe('Exactly one locator: {ref} | {selector} | {role,name?} | {label} | {text} | {testid} | {x,y}. frame/within/nth only narrow it');

function text(s: string): Content[number] { return { type: 'text', text: s }; }
// One result envelope everywhere: success is `{ ok:true, …data }`, failure is `{ ok:false, error:{…} }` — compact JSON,
// in-band `ok` (the agent reads content text), no duplicate structuredContent. Raw strings (docs/markdown) pass through.
function ok(data: unknown, images: Array<{ mimeType: string; base64: string }> = []): ToolResult {
  const content: Content = [];
  if (typeof data === 'string') content.push(text(data));
  else if (Array.isArray(data)) content.push(text(safeStringify({ ok: true, value: data }, 120_000)));
  else if (data && typeof data === 'object') content.push(text(safeStringify({ ok: true, ...(data as Record<string, unknown>) }, 120_000)));
  else content.push(text(safeStringify({ ok: true }, 120_000)));
  for (const img of images) content.push({ type: 'image', data: img.base64, mimeType: img.mimeType });
  return { content };
}
function fail(err: unknown): ToolResult {
  return { content: [text(safeStringify(errorEnvelope(err)))], isError: true };
}
function stripImage<T extends Record<string, unknown>>(o: T): { data: Record<string, unknown>; images: Array<{ mimeType: string; base64: string }> } {
  const images: Array<{ mimeType: string; base64: string }> = [];
  const data: Record<string, unknown> = { ...o };
  const img = o.image as { __image?: boolean; mimeType: string; base64: string } | undefined;
  if (img && img.__image) { images.push({ mimeType: img.mimeType, base64: img.base64 }); data.image = `${img.mimeType} attached`; }
  return { data, images };
}

export interface SessionServer { server: McpServer; api: AgentApi; close(): Promise<void> }

export function createMcpServer(rt: Runtime, sessionId: string, opts: { version?: string; persistent?: boolean } = {}): SessionServer {
  const persistent = opts.persistent !== false; // stateless HTTP creates a fresh server per request: no long-lived rt listeners, and close() must not finalize the shared runtime session
  const api = createAgentApi(rt, sessionId);
  const state = rt.session(sessionId);
  const docCtx = (): DocContext => ({ backend: rt.backend(), capabilities: [...state.capabilities] });
  const server = new McpServer({ name: 'opencli-mcp', version: opts.version ?? '0.0.12' }, {
    capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: {}, logging: {} },
    instructions: buildInstructions(docCtx()),
  });

  const tabOf = async (id?: string): Promise<Tab> => {
    const b = await api.agent.browsers.getDefault();
    if (id) return b.tabs.get(id);
    // selected is the last tab this session touched, not a disambiguator. The lease list is the only source.
    const tabs = await b.tabs.list();
    if (tabs.length > 1) throw new ActionError('tab_required', `This session has ${tabs.length} tabs. Pass tab.`, 'Copy tab from this list.', { details: { tabs: tabs.map((t) => ({ tab: t.id, url: t.url, title: t.title })) } });
    if (tabs.length === 1) return b.tabs.get(tabs[0].id);
    throw new ActionError('no_tab', 'No tab is open in this session', 'Call tab_open first (or tab_claim a user tab).');
  };
  const run = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => { try { return await fn(); } catch (err) { return fail(err); } };
  type Extra = { signal?: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification?: (n: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void> };
  // v2 ServerContext carries request state under `mcpReq` (signal, _meta, notify) — lift the pieces we use.
  const ctxExtra = (ctx: unknown): Extra => {
    const m = (ctx as { mcpReq?: { signal?: AbortSignal; _meta?: { progressToken?: string | number }; notify?: (n: unknown) => Promise<void> } }).mcpReq ?? {};
    return { signal: m.signal, _meta: m._meta, sendNotification: m.notify ? (n) => m.notify!(n) : undefined };
  };
  /** Run a long site command with progress heartbeats (when the host passed a progressToken) and cancellation. */
  const runSiteWithProgress = async (site: string, command: string, args: Record<string, unknown>, extra: Extra): Promise<ToolResult> => {
    const cmd = await rt.registry.resolve(site, command);
    const coerced = coerceArgs(cmd.args, args);
    const token = extra._meta?.progressToken;
    const started = Date.now();
    let beat: NodeJS.Timeout | undefined;
    if (token !== undefined && extra.sendNotification) {
      beat = setInterval(() => { void extra.sendNotification!({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round((Date.now() - started) / 1000), message: `${site} ${command} running (${Math.round((Date.now() - started) / 1000)}s)` } }).catch(() => {}); }, 5000);
    }
    try {
      const r = await rt.runSite(sessionId, site, command, coerced, { signal: extra.signal });
      if (!r.ok) {
        const { code, message, hint, ...restErr } = r.error;
        return fail(new ActionError(code, message, hint, { site, command, ...restErr }));
      }
      return ok(r.rows !== undefined ? { rows: r.rows, ...(r.nextCursor && { nextCursor: r.nextCursor }) } : { value: r.value });
    } finally { if (beat) clearInterval(beat); }
  };
  // ── the entry surface: the few typed tools for the core loop; everything else lives in the object model behind `js` ──
  // ── diagnostics & discovery ──
  server.registerTool('doctor', { title: 'Doctor', description: 'Runtime status: backend (extension/none), extension version, site/command counts, sessions.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => run(async () => ok(rt.doctor())));

  // ── session ──
  server.registerTool('session_finalize', { title: 'Finalize session tabs', description: 'End-of-task cleanup. Agent-created tabs not listed in keep are closed; deliverable tabs leave the group and stay open; handoff tabs stay in the group for a later turn. Claimed user tabs are only released.',
    inputSchema: { keep: z.array(z.object({ tab: z.string().describe('tab id'), status: z.enum(['deliverable', 'handoff']) })).default([]) },
    annotations: { destructiveHint: true },
  }, async ({ keep }) => run(async () => ok(await (await api.agent.browsers.getDefault()).tabs.finalize({ keep }))));

  // ── tabs ──
  server.registerTool('tab_open', { title: 'Open a tab', description: 'Open a URL in a new agent tab (background, in this session’s tab group) and return its id plus the initial page state.',
    inputSchema: { url: z.string().optional().describe('http(s) URL, or data:text/html,… for a scratch page'), observe: z.boolean().default(true), session: z.string().min(1).max(60).optional().describe('name this browser session (short, emoji-prefixed; becomes the Chrome tab-group title) — give it with the first tab') },
    annotations: { openWorldHint: true },
  }, async ({ url, observe, session: sessionName }) => run(async () => {
    const b = await api.agent.browsers.getDefault();
    if (sessionName) await b.nameSession(sessionName);
    const tab = await b.tabs.new(url);
    if (!observe) return ok({ tab: tab.id, url });
    const { data, images } = stripImage({ tab: tab.id, ...(await tab.observe({ diff: false })) });
    return ok(data, images);
  }));
  server.registerTool('tab_claim', { title: 'Claim a user tab', description: 'Take control of a tab the user already has open. tabId (from browser.user.openTabs() in js) is enough; or give url (exact or prefix) and/or title (substring) to find it — the match must be unique. url/title together with a tabId are guards that fail closed if the tab changed. The tab is not moved into the agent group and is never closed by finalize.',
    inputSchema: { tabId: z.number().int().optional(), title: z.string().optional(), url: z.string().optional(), observe: z.boolean().default(true) },
    annotations: { openWorldHint: true },
  }, async ({ tabId, title, url, observe }) => run(async () => {
    const b = await api.agent.browsers.getDefault();
    const tab = await b.user.claimTab({ tabId, title, url });
    if (!observe) return ok({ tab: tab.id });
    const { data, images } = stripImage({ tab: tab.id, ...(await tab.observe({ diff: false })) });
    return ok(data, images);
  }));
  server.registerTool('tab_observe', { title: 'Observe a tab', description: 'Action map: an accessibility snapshot with [ref=eN] refs for tab_act, and/or a screenshot. Not the document — long text is tab_read. A branch marked (collapsed) still has its ref; pass ref:"eN" to open that one branch. viewport:true is only the on-screen subtree, not the next page of the tree. diff defaults off: pass diff:true only when you still have the previous snapshot in context. A diff is against the server cache, not against what you remember.',
    inputSchema: { tab: z.string().optional().describe('required when the session has more than one tab'), mode: z.enum(['state', 'screenshot', 'both']).default('state'), diff: z.boolean().default(false).describe('true only if the previous full snapshot is still in your context'), viewport: z.boolean().optional().describe('only the subtree on screen right now (what a screenshot shows)'), ref: z.string().optional().describe('open one collapsed branch (eN). Ignores viewport'), annotate: z.boolean().default(false).describe('overlay eN labels on the screenshot'), fullPage: z.boolean().default(false) },
    annotations: { readOnlyHint: true },
  }, async ({ tab, ...o }) => run(async () => { const t = await tabOf(tab); const { data, images } = stripImage({ tab: t.id, ...(await t.observe(o)) }); return ok(data, images); }));
  server.registerTool('tab_read', { title: 'Read page text', description: 'Linear text of a bounded document, article, or chat log. Scrolls internally to mount lazy content, deduplicates lines, then restores the scroll position. No refs — this is not the action map (that is tab_observe). complete:false means the returned text is the head, not a cursor: another call starts from the top and does not continue. reason:"unbounded" is a feed with no bottom. reason:"budget" is the character or step cap.',
    inputSchema: { tab: z.string().optional().describe('required when the session has more than one tab'), maxChars: z.number().int().min(200).max(80_000).optional().describe('stop after this many characters (default 60000)') },
    annotations: { readOnlyHint: true },
  }, async ({ tab, maxChars }) => run(async () => { const t = await tabOf(tab); return ok({ tab: t.id, ...(await t.read(maxChars ? { maxChars } : {})) }); }));
  server.registerTool('tab_act', { title: 'Act on a tab', description: 'One action: click, dblclick, hover, focus, fill (replace; value required, "" clears), type (append), press (key, no default), select, check/uncheck, upload (files), drag (to), scroll, back/forward/reload. Exactly one locator on target. Extra fields for that action are invalid_args with details.expected. Waits for actionability and dispatches a real mouse or key event. click fails with not_delivered when the page receives no pointerdown or mousedown. method:"dom" is click-only: HTMLElement.click() and no mouse event, only after not_delivered or a target with no box. Do not send method:"dom" after a click that already returned ok.',
    inputSchema: { tab: z.string().optional().describe('required when the session has more than one tab'), action: z.enum(['click', 'dblclick', 'hover', 'focus', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'upload', 'drag', 'scroll', 'back', 'forward', 'reload']), target: targetSchema.optional(), value: z.string().optional().describe('fill/type text, press key, or select option. Required for those actions; "" fill clears'), files: z.array(z.string()).optional().describe('upload only'), to: targetSchema.optional().describe('drag only'), direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('scroll only'), amount: z.number().optional().describe('scroll only'), method: z.enum(['cdp', 'dom']).optional().describe('click only. dom = HTMLElement.click(), no mouse event. Default cdp = real mouse event'), settleMs: z.number().int().min(0).max(10_000).default(600).describe('wait for the DOM to settle after the action'), observe: z.boolean().default(false).describe('also return the page state after the action') },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async ({ tab, action, target, to, observe, value, files, direction, amount, settleMs, method }) => run(async () => {
    const checked = checkActInput({ action: action as ActAction, target, to, value, files, direction, amount, method });
    const t = await tabOf(tab);
    const r = await t.act({ action: action as ActAction, target: checked.target, to: checked.to, value, files, direction, amount, settleMs, method: checked.method });
    if (!observe) return ok({ tab: t.id, ...r });
    const { data, images } = stripImage({ tab: t.id, ...r, after: await t.observe() });
    return ok(data, images);
  }));
  server.registerTool('tab_expect', { title: 'Expect', description: 'Assert what the page must show now. At least one of text / notText / url / title / selector / ref is required (visible:false requires absence, and needs selector or ref). Polls up to timeout seconds; fails with expectation_failed. Recorded so tools_compile turns it into a checkpoint.', inputSchema: { tab: z.string().optional().describe('required when the session has more than one tab'), text: z.string().optional(), notText: z.string().optional(), url: z.string().optional(), title: z.string().optional(), selector: z.string().optional(), ref: z.string().optional(), visible: z.boolean().optional().describe('with selector or ref; false requires absence'), timeout: z.number().default(5) }, annotations: { readOnlyHint: true } }, async ({ tab, timeout, ...what }) => run(async () => { checkExpect(what); const t = await tabOf(tab); return ok({ tab: t.id, ...(await t.expect(what, { timeoutMs: timeout * 1000 })) }); }));

  // ── sites ──
  server.registerTool('sites_search', { title: 'Search sites & commands', description: 'Find site commands by keyword or domain. Each hit includes args[{name,type,required,help,default,choices}] — copy those into site_run. Do not invent parameters.', inputSchema: { query: z.string(), limit: z.number().int().max(100).default(20) }, annotations: { readOnlyHint: true } }, async ({ query, limit }) => run(async () => ok({ results: await api.sites.search(query, limit) })));
  server.registerTool('site_run', { title: 'Run a site command', description: 'Run one site command. args must match the args list from sites_search. Invalid args return invalid_args with details.expected. Valid commands execute directly, including writes.', inputSchema: { site: z.string(), command: z.string(), args: z.record(z.string(), z.unknown()).default({}) }, annotations: { openWorldHint: true } }, async ({ site, command, args }, extra) => run(() => runSiteWithProgress(site, command, args, ctxExtra(extra))));

  // ── capabilities ──

  // ── recon & tools ──
  const argDef = z.object({ name: z.string(), type: z.enum(['string', 'int', 'number', 'boolean']).optional(), default: z.unknown().optional(), required: z.boolean().optional(), help: z.string().optional(), choices: z.array(z.string()).optional() });
  server.registerTool('tools_define', { title: 'Define a tool', description: 'Freeze a flow into a persistent adapter — usable as sites.<site>.<name>() in js and the <site>_<name> tool. `func` is the source of `async ({ tab, args, sites, recon }) => {…}` on the object model (API-first: tab.fetchJson to the site\'s own API; never DOM when an API exists). Written to your ~/.opencli-mcp/adapters source; live immediately.',
    inputSchema: { site: z.string(), name: z.string(), description: z.string(), access: z.enum(['read', 'write']), browser: z.boolean().optional().describe('needs a logged-in page (default: inferred from whether func uses tab/sites/recon)'), domain: z.string().optional(), args: z.array(argDef).optional(), func: z.string() },
  }, async (def) => run(async () => ok(await api.tools.define(def))));
  server.registerTool('tools_compile', { title: 'Compile a tool from the trace', description: 'Draft a tool definition from this session’s recorded steps (network-first, else UI steps). inputs maps arg names to the literal values you used so they become parameters. Review, then tools_define.', inputSchema: { site: z.string(), name: z.string(), description: z.string(), access: z.enum(['read', 'write']).default('read'), inputs: z.record(z.string(), z.union([z.string(), z.object({ sample: z.string(), description: z.string().optional(), type: z.enum(['string', 'int', 'number', 'boolean']).optional(), required: z.boolean().optional(), mode: z.enum(['exact', 'within']).optional().describe('exact (default): only whole literals equal to the sample become the argument; within: also inside longer literals such as typed text or expectation texts/urls') })])).default({}).describe('parameters of the tool: name → the literal value you used during the flow (or {sample, description, type, mode})'), domain: z.string().optional(), save: z.boolean().default(false) } }, async ({ save, ...o }) => run(async () => { const draft = api.tools.compile(o); if (!save) return ok({ draft }); return ok({ draft, saved: await api.tools.define(draft) }); }));

  // ── docs ──
  server.registerTool('docs_list', { title: 'List docs', description: 'Documentation available for this backend.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => run(async () => ok({ docs: listDocs(docCtx()).filter((d) => d.available).map(({ name, mode, description }) => ({ name, mode, description })) })));
  server.registerTool('docs_get', { title: 'Read a doc', description: 'Read a documentation page by name (see docs_list).', inputSchema: { name: z.string() }, annotations: { readOnlyHint: true } }, async ({ name }) => run(async () => { const d = readDoc(name); if (!d) throw new ActionError('unknown_doc', `no doc "${name}"`, 'Call docs_list to see available docs.'); return ok(d); }));

  // ── code mode ──
  const jsGlobals = { agent: api.agent, browser: api.agent.browser, sites: api.sites, recon: api.recon, tools: api.tools, session: api.session, Tab };
  server.registerTool('js', {
    title: 'JavaScript session', description: 'Host-side JavaScript against the object model, not page JavaScript. Page scripts go through tab.evaluate. Pre-bound: browser, agent, sites, recon, tools, session. Top-level const/let persist; the last expression is returned. Example: const tab = await browser.tabs.new(url); await tab.observe(); await sites.twitter.bookmarks({ limit: 5 }). First call also returns the API reference — read it once.',
    inputSchema: { code: z.string(), timeoutMs: z.number().int().max(1_800_000).default(300_000) },
    annotations: { openWorldHint: true, destructiveHint: true },
  }, async ({ code, timeoutMs }) => run(async () => {
    if (!state.js) state.js = new JsSession(jsGlobals);
    const first = state.js.runs === 0;
    const r = await state.js.run(code, { timeoutMs });
    const content: Content = [];
    if (first) { const b = rt.backend(); const ref = readDoc('api-reference') ?? ''; const doc = b === 'none' ? `${readDoc('js-tool') ?? ''}\n\n${ref}\n\n(No browser backend connected: browser objects will throw browser_unavailable; site commands with browser:false work.)` : `${readDoc('js-tool') ?? ''}\n\n${ref}`; content.push(text(`# API\n${doc}\n\n# Result`)); }
    if (r.writes.length) {
      const joined = r.writes.join('\n');
      content.push(text(joined.length > 24_000 ? `${joined.slice(0, 24_000)}\n…(truncated ${joined.length - 24_000} chars)` : joined));
    }
    if (r.error) {
      // Same coded envelope as every other tool: branchable code/hint/data when the throw was an ActionError, else a generic js_error.
      const e = r.error;
      const env = { ok: false as const, error: { code: e.code ?? 'js_error', message: e.message, ...(e.hint && { hint: e.hint }), ...(e.data && { ...e.data }), ...(!e.code && e.stack && { stack: e.stack }) } };
      content.push(text(safeStringify(env, 120_000)));
    } else if (r.value !== undefined) content.push(text(safeStringify({ ok: true, value: r.value }, 120_000)));
    else if (!r.writes.length) content.push(text(safeStringify({ ok: true, value: null }, 120_000)));
    for (const img of r.images) content.push({ type: 'image', data: img.base64, mimeType: img.mimeType });
    return { content, isError: Boolean(r.error) };
  }));
  server.registerTool('js_reset', { title: 'Reset JavaScript session', description: 'Discard all JavaScript bindings (tabs and browser state are untouched).', inputSchema: {} }, async () => run(async () => { state.js?.reset(); return ok({ reset: true }); }));

  // ── dynamic site tools ──
  const siteTools = new Map<string, RegisteredTool>();
  const syncSiteTools = async (): Promise<void> => {
    const wanted = new Set<string>();
    for (const [site, { write }] of state.enabledSites) {
      for (const cmd of await rt.registry.commands(site)) {
        if (!write && cmd.access === 'write') continue;
        const name = `${site}_${cmd.name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
        wanted.add(name);
        if (siteTools.has(name)) continue;
        const reg = server.registerTool(name, {
          title: `${site} ${cmd.name}`,
          description: `${cmd.description}${cmd.domain ? ` (${cmd.domain})` : ''} [${cmd.access}]`,
          inputSchema: argsToShape(cmd.args),
          annotations: { readOnlyHint: cmd.access === 'read', destructiveHint: cmd.access === 'write', openWorldHint: true },
          ...(cmd.domain ? { icons: [{ src: `https://${cmd.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}/favicon.ico` }] } : {}),
        }, async (args, extra) => run(() => runSiteWithProgress(site, cmd.name, args as Record<string, unknown>, ctxExtra(extra))));
        siteTools.set(name, reg);
      }
    }
    for (const [name, reg] of siteTools) if (!wanted.has(name)) { reg.remove(); siteTools.delete(name); }
    if (server.isConnected()) server.sendToolListChanged();
  };
  const onToolsChanged = (): void => { void syncSiteTools().catch((err) => rt.emit('log', `syncSiteTools failed: ${(err as Error).message}`)); };
  if (persistent) rt.on('tools-changed', onToolsChanged);
  const onLog = (msg: string): void => { if (server.isConnected()) void server.sendLoggingMessage({ level: 'info', logger: 'opencli-mcp', data: msg }).catch(() => {}); };
  if (persistent) rt.on('log', onLog);
  const onBrowserEvent = (e: { kind: string; session?: string }): void => {
    if (!server.isConnected()) return;
    if (e.session && e.session !== `mcp:${sessionId}`) return;
    // tabs are not exposed as a resource, so tab events don't change any resource list — just relay them on the browser log channel.
    void server.sendLoggingMessage({ level: 'info', logger: 'browser', data: e }).catch(() => {});
  };
  if (persistent) rt.on('browser-event', onBrowserEvent);
  // sites pre-enabled by config apply to every session
  for (const site of rt.configSites) if (rt.registry.has(site)) state.enabledSites.set(site, { write: rt.configSitesWrite.includes(site) });
  if (state.enabledSites.size) queueMicrotask(onToolsChanged);

  // ── resources ──
  server.registerResource('docs', new ResourceTemplate('opencli://docs/{name}', { list: async () => ({ resources: listDocs(docCtx()).filter((d) => d.available).map((d) => ({ uri: `opencli://docs/${d.name}`, name: d.name, description: d.description, mimeType: 'text/markdown' })) }) }), { title: 'Documentation', description: 'Agent-facing docs' }, async (uri, { name }) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: readDoc(String(name)) ?? `no doc ${String(name)}` }] }));
  server.registerResource('sites', 'opencli://sites', { title: 'Sites', description: 'All sites with command counts', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(api.sites.list(), null, 2) }] }));
  server.registerResource('site', new ResourceTemplate('opencli://sites/{site}', { list: undefined }), { title: 'Site commands', mimeType: 'application/json' }, async (uri, { site }) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify((await rt.registry.commands(String(site))).map((c) => ({ name: c.name, description: c.description, access: c.access, domain: c.domain, args: c.args })), null, 2) }] }));

  // ── prompts ──
  server.registerPrompt('browse', { title: 'Browse a site for a goal', description: 'Structured plan: prefer site tools, then observe → act → observe, finalize.', argsSchema: { goal: z.string(), url: z.string().optional() } }, ({ goal, url }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Goal: ${goal}${url ? `\nStart at: ${url}` : ''}\n\n1. sites_search for an existing command that covers the goal; if found, site_run it (or sites.enable(site) in js for typed tools).\n2. Otherwise tab_open with a session name, then loop tab_observe → tab_act → tab_expect, reading error codes.\n3. Finish with session_finalize, keeping only deliverable/handoff tabs.` } }] }));
  server.registerPrompt('write-tool', { title: 'Turn a flow into a tool', description: 'Explore, discover the API, verify, then tools_define.', argsSchema: { site: z.string(), goal: z.string() } }, ({ site, goal }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Create a reusable ${site} tool for: ${goal}\n\n1. Open the site, arm capture (await tab.network.start() in js), perform the flow once, and tab_expect what each step must show.\n2. await recon.discover(tab) in js to list endpoint candidates; verify the best one with tab.evaluate (fetch).\n3. tools_compile with explicit inputs (sample/description/mode); review the draft; tools_define it; run it once to verify.` } }] }));

  return {
    server, api,
    close: async () => { if (!persistent) return; rt.off('tools-changed', onToolsChanged); rt.off('log', onLog); rt.off('browser-event', onBrowserEvent); await rt.closeSession(sessionId); },
  };
}
