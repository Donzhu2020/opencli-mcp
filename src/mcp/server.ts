/**
 * MCP server per session: typed core tools, dynamic site tools, the `js` code-mode tool,
 * resources (docs, sites, tabs, trace) and prompts — all backed by the same object model.
 */
import { McpServer, ResourceTemplate, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Runtime } from '../runtime/runtime.js';
import { createAgentApi, Tab, type AgentApi, type Target, type ActAction } from '../api/agent.js';
import { ActionError, errorEnvelope } from '../api/errors.js';
import { JsSession, safeStringify } from './js-session.js';
import { buildInstructions, listDocs, readDoc, requiredDocsFor, DOCS_MANIFEST, type DocContext } from '../docs/manifest.js';
import { argsToShape } from '../sites/schema.js';
import { listDefinedTools } from '../sites/define.js';
import { readSiteKnowledge, writeSiteKnowledge } from '../sites/knowledge.js';

type Content = Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
type ToolResult = { content: Content; structuredContent?: Record<string, unknown>; isError?: boolean };

const targetSchema = z.object({
  ref: z.string().optional().describe('eN ref from tab_observe / tab_find'),
  selector: z.string().optional().describe('raw Playwright selector, e.g. the selector returned by tab_find'),
  css: z.string().optional().describe('CSS selector; add nth for multiple matches'),
  nth: z.number().int().optional(),
  role: z.string().optional().describe('ARIA role, e.g. button, link, textbox'),
  name: z.string().optional().describe('accessible name (with role)'),
  label: z.string().optional().describe('form label text'),
  text: z.string().optional().describe('visible text'),
  testid: z.string().optional().describe('data-testid'),
  x: z.number().optional().describe('viewport x (with y) for coordinate clicks'),
  y: z.number().optional(),
  frame: z.union([z.string(), z.number().int(), z.array(z.union([z.string(), z.number().int()]))]).optional().describe('iframe(s) to enter first, outermost first: css selector of the <iframe> or its 0-based index; chain with an array or "outer >> inner"; same-origin and cross-origin alike'),
}).describe('One of: {ref} | {css,nth?} | {role,name} | {label} | {text} | {testid} | {x,y}; add frame to target inside a same-origin iframe');

function pickTarget(t: z.infer<typeof targetSchema> | undefined): Target | undefined {
  if (!t) return undefined;
  if (t.ref !== undefined) return { ref: t.ref, frame: t.frame };
  if (t.selector) return { selector: t.selector, nth: t.nth, frame: t.frame };
  if (t.css) return { css: t.css, nth: t.nth, frame: t.frame };
  if (t.x !== undefined && t.y !== undefined) return { x: t.x, y: t.y };
  if (t.role || t.name || t.label || t.text || t.testid) return { role: t.role, name: t.name, label: t.label, text: t.text, testid: t.testid, nth: t.nth, frame: t.frame };
  return undefined;
}

function text(s: string): Content[number] { return { type: 'text', text: s }; }
function ok(data: unknown, images: Array<{ mimeType: string; base64: string }> = []): ToolResult {
  const content: Content = [];
  if (typeof data === 'string') content.push(text(data));
  else if (data !== undefined) content.push(text(safeStringify(data, 120_000)));
  for (const img of images) content.push({ type: 'image', data: img.base64, mimeType: img.mimeType });
  const structured = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  return { content, ...(structured && { structuredContent: structured }) };
}
function fail(err: unknown): ToolResult {
  const env = errorEnvelope(err);
  return { content: [text(safeStringify(env))], structuredContent: env, isError: true };
}
function stripImage<T extends Record<string, unknown>>(o: T): { data: Record<string, unknown>; images: Array<{ mimeType: string; base64: string }> } {
  const images: Array<{ mimeType: string; base64: string }> = [];
  const data: Record<string, unknown> = { ...o };
  const img = o.image as { __image?: boolean; mimeType: string; base64: string } | undefined;
  if (img && img.__image) { images.push({ mimeType: img.mimeType, base64: img.base64 }); data.image = `${img.mimeType} attached`; }
  return { data, images };
}

export interface SessionServer { server: McpServer; api: AgentApi; close(): Promise<void> }

export function createMcpServer(rt: Runtime, sessionId: string, opts: { version?: string } = {}): SessionServer {
  const api = createAgentApi(rt, sessionId);
  const state = rt.session(sessionId);
  const docCtx = (): DocContext => ({ backend: rt.backend(), capabilities: [...state.capabilities] });
  const server = new McpServer({ name: 'opencli-mcp', version: opts.version ?? '0.1.0' }, {
    capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: {}, logging: {} },
    instructions: buildInstructions(docCtx()),
  });

  const tabOf = async (id?: string): Promise<Tab> => {
    const b = await api.agent.browsers.getDefault();
    if (id) return b.tabs.get(id);
    const t = await b.tabs.selected();
    if (!t) throw new ActionError('no_tab', 'No tab is open in this session', 'Call tab_open first (or tab_claim a user tab).');
    return t;
  };
  const run = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => { try { return await fn(); } catch (err) { return fail(err); } };
  /** Ask the user through MCP elicitation when the host supports it; null = host cannot ask (fall back to the error shape). */
  const elicitApproval = async (title: string, message: string): Promise<boolean | null> => {
    const caps = server.server.getClientCapabilities();
    if (!caps?.elicitation) return null;
    try {
      const r = await server.server.elicitInput({ message: `${title}: ${message}`, requestedSchema: { type: 'object', properties: { approve: { type: 'boolean', title: 'Approve this action', description: message } }, required: ['approve'] } });
      return r.action === 'accept' && Boolean((r.content as { approve?: boolean } | undefined)?.approve);
    } catch { return null; }
  };
  type Extra = { signal?: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification?: (n: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void> };
  /** Run a long site command with progress heartbeats (when the host passed a progressToken) and cancellation. */
  const runSiteWithProgress = async (site: string, command: string, args: Record<string, unknown>, extra: Extra): Promise<ToolResult> => {
    const { confirm, ...rest } = args as { confirm?: boolean } & Record<string, unknown>;
    const cmd = await rt.registry.resolve(site, command);
    if (cmd.access === 'write') {
      const d = rt.policy.checkWrite(`${site}/${command}`, Boolean(confirm));
      if (!d.allowed) {
        const approved = await elicitApproval(`${site} ${command}`, `Run ${site}/${command} with ${JSON.stringify(rest).slice(0, 300)}? This changes the user's account or sends data.`);
        if (approved === null) throw new ActionError(d.code, d.message, d.hint, { retryable: d.retryable });
        if (!approved) throw new ActionError('user_declined', `The user declined ${site}/${command}`, undefined, { retryable: false });
      }
    }
    const token = extra._meta?.progressToken;
    const started = Date.now();
    let beat: NodeJS.Timeout | undefined;
    if (token !== undefined && extra.sendNotification) {
      beat = setInterval(() => { void extra.sendNotification!({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round((Date.now() - started) / 1000), message: `${site} ${command} running (${Math.round((Date.now() - started) / 1000)}s)` } }).catch(() => {}); }, 5000);
    }
    const abort = new Promise<never>((_, rej) => { extra.signal?.addEventListener('abort', () => rej(new ActionError('cancelled', `${site}/${command} cancelled by the client`)), { once: true }); });
    try {
      const r = await Promise.race([rt.runSite(sessionId, site, command, rest), abort]);
      return r.ok ? ok(r) : fail(new ActionError(r.error.code, r.error.message, r.error.hint, { site, command }));
    } finally { if (beat) clearInterval(beat); }
  };
  const gate = (tool: string): void => {
    const missing = requiredDocsFor(tool, docCtx()).filter((d) => !state.docsRead.has(d));
    if (missing.length) throw new ActionError('read_docs_first', `Read ${missing.join(', ')} before using ${tool}`, `Call docs_get with name ${JSON.stringify(missing[0])}; the doc is then marked as read for this session.`, { docs: missing });
  };

  // ── diagnostics & discovery ──
  server.registerTool('doctor', { title: 'Doctor', description: 'Runtime status: backend (extension/none), extension version, site/command counts, sessions.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => run(async () => ok(rt.doctor())));
  server.registerTool('browser_list', { title: 'List browsers', description: 'Available browser backends and whether they are connected.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => run(async () => ok(await api.agent.browsers.list())));

  // ── session ──
  server.registerTool('session_name', { title: 'Name the session', description: 'Name this browser session (short, emoji-prefixed). Becomes the Chrome tab-group title. Call before opening tabs.', inputSchema: { name: z.string().min(1).max(60) } }, async ({ name }) => run(async () => { await api.session.name(name); return ok({ ok: true, name }); }));
  server.registerTool('session_finalize', {
    title: 'Finalize session tabs', description: 'End-of-task cleanup. Agent-created tabs not listed in keep are closed; deliverable tabs leave the group and stay open; handoff tabs stay in the group for a later turn. Claimed user tabs are only released.',
    inputSchema: { keep: z.array(z.object({ tab: z.string().describe('tab id'), status: z.enum(['deliverable', 'handoff']) })).default([]) },
  }, async ({ keep }) => run(async () => ok(await api.session.finalize(keep))));

  // ── tabs ──
  server.registerTool('tab_open', {
    title: 'Open a tab', description: 'Open a URL in a new agent tab (background, in this session’s tab group) and return its id plus the initial page state.',
    inputSchema: { url: z.string().optional().describe('http(s) URL, or data:text/html,… for a scratch page'), observe: z.boolean().default(true) },
  }, async ({ url, observe }) => run(async () => {
    const b = await api.agent.browsers.getDefault();
    const tab = await b.tabs.new(url);
    if (!observe) return ok({ tab: tab.id, url });
    const { data, images } = stripImage({ tab: tab.id, ...(await tab.observe({ diff: false })) });
    return ok(data, images);
  }));
  server.registerTool('tab_list', { title: 'List tabs', description: 'Tabs of this session, or with user:true the tabs the user has open (for tab_claim).', inputSchema: { user: z.boolean().default(false) }, annotations: { readOnlyHint: true } }, async ({ user }) => run(async () => {
    const b = await api.agent.browsers.getDefault();
    return ok(user ? { userTabs: await b.user.openTabs() } : { tabs: await b.tabs.list() });
  }));
  server.registerTool('tab_claim', {
    title: 'Claim a user tab', description: 'Take control of a tab the user already has open. tabId from tab_list(user:true) is enough; or give url (exact or prefix) and/or title (substring) to find it — the match must be unique. url/title together with a tabId are guards that fail closed if the tab changed. The tab is not moved into the agent group and is never closed by finalize.',
    inputSchema: { tabId: z.number().int().optional(), title: z.string().optional(), url: z.string().optional(), observe: z.boolean().default(true) },
  }, async ({ tabId, title, url, observe }) => run(async () => {
    const b = await api.agent.browsers.getDefault();
    const tab = await b.user.claimTab({ tabId, title, url });
    if (!observe) return ok({ tab: tab.id });
    const { data, images } = stripImage({ tab: tab.id, ...(await tab.observe({ diff: false })) });
    return ok(data, images);
  }));
  server.registerTool('tab_observe', {
    title: 'Observe a tab', description: 'Current page state as an accessibility snapshot with [ref=eN] refs (diff vs the previous observe when the page changed only a little), and/or a screenshot. Refs are tab_act targets ({ref:"e12"}). Prefer state over screenshot.',
    inputSchema: { tab: z.string().optional(), mode: z.enum(['state', 'screenshot', 'both']).default('state'), diff: z.boolean().default(true), viewport: z.boolean().optional().describe('only the subtree on screen right now (what a screenshot shows)'), annotate: z.boolean().default(false).describe('overlay eN labels on the screenshot'), fullPage: z.boolean().default(false) },
    annotations: { readOnlyHint: true },
  }, async ({ tab, ...o }) => run(async () => { const t = await tabOf(tab); const { data, images } = stripImage({ tab: t.id, ...(await t.observe(o)) }); return ok(data, images); }));
  server.registerTool('tab_find', { title: 'Find elements', description: 'Query elements with the same engine and locator semantics tab_act uses (css, selector, ref, role/name/label/text/testid), or describe the element under a point {x,y} (screenshot coordinates). Each entry has a replayable selector: pass it to tab_act as {selector}.', inputSchema: { tab: z.string().optional(), target: targetSchema, limit: z.number().int().max(100).default(20) }, annotations: { readOnlyHint: true } }, async ({ tab, target, limit }) => run(async () => {
    const t = await tabOf(tab); const tg = pickTarget(target); if (!tg) throw new ActionError('invalid_target', 'find needs css, a semantic locator, or a point {x,y}');
    return ok(await t.find({ ...tg, limit }));
  }));
  server.registerTool('tab_act', {
    title: 'Act on a tab', description: 'Perform one action: click, dblclick, hover, focus, fill (replace), type (append), press (key), select (option label/value), check/uncheck, upload (files), drag (to), scroll (target or direction), back/forward/reload. Waits for actionability, dispatches real input, returns matches_n/match_level and branchable error codes.',
    inputSchema: { tab: z.string().optional(), action: z.enum(['click', 'dblclick', 'hover', 'focus', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'upload', 'drag', 'scroll', 'back', 'forward', 'reload']), target: targetSchema.optional(), value: z.string().optional().describe('text for fill/type, key for press, option for select'), files: z.array(z.string()).optional(), to: targetSchema.optional(), direction: z.enum(['up', 'down', 'left', 'right']).optional(), amount: z.number().optional(), settleMs: z.number().int().min(0).max(10_000).default(600).describe('wait for the DOM to settle after the action'), confirm: z.boolean().optional().describe('set true after the user approved a consequential action (needs_confirmation)'), observe: z.boolean().default(false).describe('also return the page state after the action') },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async ({ tab, action, target, to, observe, ...rest }) => run(async () => {
    const t = await tabOf(tab);
    const r = await t.act({ action: action as ActAction, target: pickTarget(target), to: pickTarget(to), ...rest });
    if (!observe) return ok({ tab: t.id, ...r });
    const { data, images } = stripImage({ tab: t.id, ...r, after: await t.observe() });
    return ok(data, images);
  }));
  server.registerTool('tab_screenshot', { title: 'Screenshot', description: 'Viewport (or full page) screenshot as an image; annotate overlays eN refs from the last observe.', inputSchema: { tab: z.string().optional(), fullPage: z.boolean().default(false), annotate: z.boolean().default(false) }, annotations: { readOnlyHint: true } }, async ({ tab, fullPage, annotate }) => run(async () => { const t = await tabOf(tab); const img = await t.screenshot({ fullPage, annotate }); return ok({ tab: t.id, image: 'attached' }, [img]); }));
  server.registerTool('tab_wait', { title: 'Wait', description: 'Wait for text, a selector, a URL substring, or a fixed time (seconds).', inputSchema: { tab: z.string().optional(), text: z.string().optional(), selector: z.string().optional(), url: z.string().optional(), time: z.number().optional(), timeout: z.number().default(15) } }, async ({ tab, ...o }) => run(async () => { const t = await tabOf(tab); return ok({ tab: t.id, ...(await t.wait(o)) }); }));
  server.registerTool('tab_dialog', { title: 'Native dialog', description: 'Read or answer a native alert/confirm/prompt/beforeunload dialog that is blocking the tab (other calls fail with dialog_open while one is open). op:get returns it or null; accept (with optional prompt text) / dismiss answer it.', inputSchema: { tab: z.string().optional(), op: z.enum(['get', 'accept', 'dismiss']).default('get'), text: z.string().optional().describe('prompt reply text for accept') } }, async ({ tab, op, text }) => run(async () => { const t = await tabOf(tab); const d = op === 'get' ? await t.dialog.get() : op === 'accept' ? await t.dialog.accept(text) : await t.dialog.dismiss(); return ok({ tab: t.id, op, dialog: d }); }));
  server.registerTool('tab_evaluate', { title: 'Evaluate (read-only)', description: 'Run read-only JavaScript in the page and return its JSON value. Writes (click/submit/navigation) are rejected — use tab_act.', inputSchema: { tab: z.string().optional(), js: z.string(), frame: z.number().int().optional(), allowWrite: z.boolean().default(false) }, annotations: { readOnlyHint: true } }, async ({ tab, js, frame, allowWrite }) => run(async () => { const t = await tabOf(tab); return ok({ tab: t.id, value: await t.evaluate(js, { frame, allowWrite }) }); }));
  server.registerTool('tab_network', { title: 'Network capture', description: 'op:start arms capture (optionally filtered by URL substring); op:read returns requests as a cursor-paged log — pass afterSequence from the previous cursor to get only new ones.', inputSchema: { tab: z.string().optional(), op: z.enum(['start', 'read']), pattern: z.string().optional(), limit: z.number().int().default(100), includeStatic: z.boolean().default(false), afterSequence: z.number().int().optional() } }, async ({ tab, op, pattern, limit, includeStatic, afterSequence }) => run(async () => { const t = await tabOf(tab); return ok(op === 'start' ? { tab: t.id, started: await t.network.start(pattern ?? '') } : { tab: t.id, ...(await t.network.read({ pattern, limit, includeStatic, afterSequence })) }); }));
  server.registerTool('tab_cookies', { title: 'Cookies', description: 'Cookies for a domain from the logged-in browser (adapter authoring only; never paste into chat).', inputSchema: { tab: z.string().optional(), domain: z.string() }, annotations: { readOnlyHint: true } }, async ({ tab, domain }) => run(async () => { const t = await tabOf(tab); return ok({ cookies: await t.cookies(domain) }); }));
  server.registerTool('tab_close', { title: 'Close tab', description: 'Close an agent tab.', inputSchema: { tab: z.string() } }, async ({ tab }) => run(async () => { await (await tabOf(tab)).close(); return ok({ closed: tab }); }));

  // ── sites ──
  server.registerTool('sites_search', { title: 'Search sites & commands', description: 'Find site commands by keyword or domain across the adapter corpus (160+ sites). Then sites_enable the site or call site_run directly.', inputSchema: { query: z.string(), limit: z.number().int().max(100).default(20) }, annotations: { readOnlyHint: true } }, async ({ query, limit }) => run(async () => ok({ results: api.sites.search(query, limit) })));
  server.registerTool('sites_enable', { title: 'Enable a site', description: 'Load a site’s commands as typed tools named <site>_<command>. Read-only commands by default; write:true adds commands that change the user’s account.', inputSchema: { site: z.string(), write: z.boolean().default(false) } }, async ({ site, write }) => run(async () => ok(api.sites.enable(site, { write }))));
  server.registerTool('sites_disable', { title: 'Disable a site', description: 'Remove a site’s tools from this session.', inputSchema: { site: z.string() } }, async ({ site }) => run(async () => ok({ site, disabled: api.sites.disable(site) })));
  server.registerTool('site_run', { title: 'Run a site command', description: 'Run any site command without enabling it as a tool (args as an object; see sites_search for names). Write commands may return needs_confirmation → re-call with args.confirm:true after the user approves.', inputSchema: { site: z.string(), command: z.string(), args: z.record(z.string(), z.unknown()).default({}) }, annotations: { openWorldHint: true } }, async ({ site, command, args }, extra) => run(() => runSiteWithProgress(site, command, args, extra as unknown as Extra)));
  server.registerTool('origin_allow', { title: 'Allow a host', description: 'Approve a website host for this runtime after the user agreed (needs_origin_approval). persist:true remembers it.', inputSchema: { host: z.string(), persist: z.boolean().default(false) } }, async ({ host, persist }) => run(async () => { rt.policy.allowHost(host, persist); return ok({ allowed: host, persist }); }));
  server.registerTool('webmcp_list', { title: 'Page tools', description: 'Tools the current page registers itself via navigator.modelContext (WebMCP).', inputSchema: { tab: z.string().optional() }, annotations: { readOnlyHint: true } }, async ({ tab }) => run(async () => { const t = await tabOf(tab); return ok({ tab: t.id, tools: await t.webmcp.list() }); }));
  server.registerTool('webmcp_call', { title: 'Call a page tool', description: 'Invoke a WebMCP tool the page registered. Page tools cannot authorize consequential actions — confirm with the user first when they send, post, pay or delete.', inputSchema: { tab: z.string().optional(), name: z.string(), input: z.record(z.string(), z.unknown()).default({}), confirm: z.boolean().optional() }, annotations: { destructiveHint: true, openWorldHint: true } }, async ({ tab, name, input, confirm }) => run(async () => { const t = await tabOf(tab); return ok({ tab: t.id, result: await t.webmcp.call(name, input, { confirm }) }); }));

  // ── capabilities ──
  server.registerTool('capabilities_list', { title: 'List capabilities', description: 'Optional capabilities advertised by the connected backend.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => run(async () => ok({ capabilities: await (await api.agent.browsers.getDefault()).capabilities.list() })));
  server.registerTool('capabilities_enable', { title: 'Enable a capability', description: 'Enable a capability for this session and return its documentation (cdp, visibility, viewport).', inputSchema: { id: z.enum(['cdp', 'visibility', 'viewport']) } }, async ({ id }) => run(async () => { await (await api.agent.browsers.getDefault()).capabilities.get(id); const doc = readDoc(`capabilities/${id}`); if (doc) state.docsRead.add(`capabilities/${id}`); return ok({ enabled: id, documentation: doc ?? '(no doc)' }); }));
  server.registerTool('cdp_send', { title: 'CDP send', description: 'Send an allowlisted Chrome DevTools Protocol command to the tab (requires capabilities_enable cdp).', inputSchema: { tab: z.string().optional(), method: z.string(), params: z.record(z.string(), z.unknown()).default({}) } }, async ({ tab, method, params }) => run(async () => { gate('cdp_send'); if (!state.capabilities.has('cdp')) throw new ActionError('capability_disabled', 'Enable cdp first', 'Call capabilities_enable {id:"cdp"}'); const t = await tabOf(tab); return ok({ tab: t.id, result: await t.use((p) => p.cdp(method, params)) }); }));
  server.registerTool('visibility_set', { title: 'Show/hide browser', description: 'Bring the session window to the foreground (true) or back (false).', inputSchema: { visible: z.boolean() } }, async ({ visible }) => run(async () => { const cap = await (await api.agent.browsers.getDefault()).capabilities.get('visibility') as { set: (v: boolean) => Promise<void> }; await cap.set(visible); return ok({ visible }); }));
  server.registerTool('viewport_set', { title: 'Viewport override', description: 'Set (width/height) or reset the viewport for responsive checks.', inputSchema: { width: z.number().int().optional(), height: z.number().int().optional(), reset: z.boolean().default(false) } }, async ({ width, height, reset }) => run(async () => { const cap = await (await api.agent.browsers.getDefault()).capabilities.get('viewport') as { set: (v: { width: number; height: number }) => Promise<unknown>; reset: () => Promise<unknown> }; if (reset || !width || !height) await cap.reset(); else await cap.set({ width, height }); return ok({ ok: true }); }));

  // ── recon & tools ──
  server.registerTool('recon_discover', { title: 'Discover endpoints', description: 'Syntax-aware scan of the page’s loaded scripts for API endpoints (fetch/XHR/jQuery/axios/WebSocket…), merged with captured network evidence. Candidates, not contracts.', inputSchema: { tab: z.string().optional(), maxScripts: z.number().int().max(200).default(40), includeAssets: z.boolean().default(false), includeInline: z.boolean().default(true), save: z.boolean().default(false).describe('persist candidates (never secrets) into site knowledge') }, annotations: { readOnlyHint: true } }, async ({ tab, ...o }) => run(async () => { state.docsRead.add('recon'); const t = await tabOf(tab); return ok(await api.recon.discover(t, o)); }));
  const argDef = z.object({ name: z.string(), type: z.enum(['string', 'int', 'number', 'boolean']).optional(), default: z.unknown().optional(), required: z.boolean().optional(), help: z.string().optional(), choices: z.array(z.string()).optional() });
  server.registerTool('tools_define', {
    title: 'Define a tool', description: 'Freeze a flow into a persistent site command (<site>_<name>, and sites.<site>.<name>() in js). Provide `func` (source of async (page, args) => {...}) or `pipeline` steps.',
    inputSchema: { site: z.string(), name: z.string(), description: z.string(), access: z.enum(['read', 'write']), strategy: z.enum(['public', 'cookie', 'intercept', 'ui', 'local']).optional(), domain: z.string().optional(), args: z.array(argDef).optional(), columns: z.array(z.string()).optional(), pipeline: z.array(z.record(z.string(), z.unknown())).optional(), func: z.string().optional(), siteSession: z.enum(['ephemeral', 'persistent']).optional() },
  }, async (def) => run(async () => ok(await api.tools.define(def))));
  server.registerTool('tools_compile', { title: 'Compile a tool from the trace', description: 'Draft a tool definition from this session’s recorded steps (network-first, else UI steps). inputs maps arg names to the literal values you used so they become parameters. Review, then tools_define.', inputSchema: { site: z.string(), name: z.string(), description: z.string(), access: z.enum(['read', 'write']).default('read'), inputs: z.record(z.string(), z.string()).default({}), domain: z.string().optional(), save: z.boolean().default(false) } }, async ({ save, ...o }) => run(async () => { const draft = api.tools.compile(o); if (!save) return ok({ draft }); return ok({ draft, saved: await api.tools.define(draft) }); }));
  server.registerTool('tools_list', { title: 'List defined tools', description: 'Agent-defined tools on disk.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => run(async () => ok({ tools: listDefinedTools() })));
  server.registerTool('tools_remove', { title: 'Remove a defined tool', description: 'Delete an agent-defined tool.', inputSchema: { site: z.string(), name: z.string() }, annotations: { destructiveHint: true } }, async ({ site, name }) => run(async () => ok({ removed: api.tools.remove(site, name) })));

  // ── docs ──
  server.registerTool('docs_list', { title: 'List docs', description: 'Documentation available for this backend.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => run(async () => ok({ docs: listDocs(docCtx()).filter((d) => d.available).map(({ name, mode, description }) => ({ name, mode, description })) })));
  server.registerTool('docs_get', { title: 'Read a doc', description: 'Read a documentation page by name (see docs_list). Marks it as read for gated tools.', inputSchema: { name: z.string() }, annotations: { readOnlyHint: true } }, async ({ name }) => run(async () => { const d = readDoc(name); if (!d) throw new ActionError('unknown_doc', `no doc "${name}"`); state.docsRead.add(name); return ok(d); }));

  // ── code mode ──
  const jsGlobals = { agent: api.agent, sites: api.sites, recon: api.recon, tools: api.tools, session: api.session, Tab };
  server.registerTool('js', {
    title: 'JavaScript session', description: 'Run JavaScript in a persistent session with the object model: agent.browsers, browser.tabs, tab.observe/act/evaluate/screenshot, sites.<site>.<command>(), recon.discover(tab), tools.define(). Top-level const/let persist; the last expression is returned; nodeRepl.write/emitImage add output. First call returns the API documentation.',
    inputSchema: { code: z.string(), timeoutMs: z.number().int().max(1_800_000).default(300_000) },
    annotations: { openWorldHint: true, destructiveHint: true },
  }, async ({ code, timeoutMs }) => run(async () => {
    if (!state.js) state.js = new JsSession(jsGlobals);
    const first = state.js.runs === 0;
    const r = await state.js.run(code, { timeoutMs });
    const content: Content = [];
    if (first) { const b = rt.backend(); const doc = b === 'none' ? `${readDoc('js-tool') ?? ''}\n\n(No browser backend connected: browser objects will throw browser_unavailable; sites.* public commands work.)` : `${readDoc('js-tool') ?? ''}`; content.push(text(`# API\n${doc}\n\n# Result`)); }
    if (r.writes.length) content.push(text(r.writes.join('\n')));
    if (r.error) content.push(text(`Error: ${r.error.name}: ${r.error.message}${r.error.stack ? `\n${r.error.stack}` : ''}`));
    else if (r.value !== undefined) content.push(text(safeStringify(r.value, 120_000)));
    else if (!r.writes.length) content.push(text('(undefined)'));
    for (const img of r.images) content.push({ type: 'image', data: img.base64, mimeType: img.mimeType });
    return { content, isError: Boolean(r.error) };
  }));
  server.registerTool('js_reset', { title: 'Reset JavaScript session', description: 'Discard all JavaScript bindings (tabs and browser state are untouched).', inputSchema: {} }, async () => run(async () => { state.js?.reset(); return ok({ reset: true }); }));

  // ── dynamic site tools ──
  const siteTools = new Map<string, RegisteredTool>();
  const syncSiteTools = (): void => {
    const wanted = new Set<string>();
    for (const [site, { write }] of state.enabledSites) {
      for (const cmd of rt.registry.commands(site)) {
        if (!write && cmd.access === 'write') continue;
        const name = `${site}_${cmd.name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
        wanted.add(name);
        if (siteTools.has(name)) continue;
        const reg = server.registerTool(name, {
          title: `${site} ${cmd.name}`,
          description: `${cmd.description}${cmd.domain ? ` (${cmd.domain})` : ''} [${cmd.access}, ${String(cmd.strategy ?? 'public')}]${cmd.columns ? ` → columns: ${cmd.columns.join(', ')}` : ''}`,
          inputSchema: argsToShape(cmd.args, { timeout: z.number().optional().describe('seconds'), ...(cmd.access === 'write' ? { confirm: z.boolean().optional().describe('set true after the user approved this write action') } : {}) }),
          annotations: { readOnlyHint: cmd.access === 'read', destructiveHint: cmd.access === 'write', openWorldHint: true },
        }, async (args, extra) => run(() => runSiteWithProgress(site, cmd.name, args as Record<string, unknown>, extra as unknown as Extra)));
        siteTools.set(name, reg);
      }
    }
    for (const [name, reg] of siteTools) if (!wanted.has(name)) { reg.remove(); siteTools.delete(name); }
    if (server.isConnected()) server.sendToolListChanged();
  };
  const onToolsChanged = (): void => { try { syncSiteTools(); } catch (err) { rt.emit('log', `syncSiteTools failed: ${(err as Error).message}`); } };
  rt.on('tools-changed', onToolsChanged);
  const onLog = (msg: string): void => { if (server.isConnected()) void server.sendLoggingMessage({ level: 'info', logger: 'opencli-mcp', data: msg }).catch(() => {}); };
  rt.on('log', onLog);
  const onBrowserEvent = (e: { kind: string; session?: string }): void => {
    if (!server.isConnected()) return;
    if (e.session && e.session !== `mcp:${sessionId}`) return;
    if (e.kind === 'tab_created' || e.kind === 'tab_acquired' || e.kind === 'tab_closed' || e.kind === 'session_released') server.sendResourceListChanged();
    void server.sendLoggingMessage({ level: 'info', logger: 'browser', data: e }).catch(() => {});
  };
  rt.on('browser-event', onBrowserEvent);
  // sites pre-enabled by config apply to every session
  for (const site of rt.configSites) if (rt.registry.has(site)) state.enabledSites.set(site, { write: rt.configSitesWrite.includes(site) });
  if (state.enabledSites.size) queueMicrotask(onToolsChanged);

  // ── resources ──
  server.registerResource('docs', new ResourceTemplate('opencli://docs/{name}', { list: async () => ({ resources: DOCS_MANIFEST.map((d) => ({ uri: `opencli://docs/${d.name}`, name: d.name, description: d.description, mimeType: 'text/markdown' })) }) }), { title: 'Documentation', description: 'Agent-facing docs' }, async (uri, { name }) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: readDoc(String(name)) ?? `no doc ${String(name)}` }] }));
  server.registerResource('sites', 'opencli://sites', { title: 'Sites', description: 'All sites with command counts', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(api.sites.list(), null, 2) }] }));
  server.registerResource('site', new ResourceTemplate('opencli://sites/{site}', { list: undefined }), { title: 'Site commands', mimeType: 'application/json' }, async (uri, { site }) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(rt.registry.commands(String(site)).map((c) => ({ name: c.name, description: c.description, access: c.access, strategy: c.strategy, domain: c.domain, args: c.args, columns: c.columns })), null, 2) }] }));
  server.registerResource('site-knowledge', new ResourceTemplate('opencli://sites/{site}/knowledge', { list: undefined }), { title: 'Site knowledge', description: 'Endpoints/notes recorded for a site (OpenCLI site memory)', mimeType: 'application/json' }, async (uri, { site }) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(readSiteKnowledge(String(site)), null, 2) }] }));
  server.registerTool('sites_knowledge', { title: 'Site knowledge', description: 'Endpoints, field maps and notes previously recorded for a site (from OpenCLI site memory and recon results). Check before re-discovering.', inputSchema: { site: z.string() }, annotations: { readOnlyHint: true } }, async ({ site }) => run(async () => ok(readSiteKnowledge(site))));
  server.registerResource('trace', 'opencli://session/trace', { title: 'Session trace', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(api.session.trace(), null, 2) }] }));
  server.registerResource('tabs', 'opencli://session/tabs', { title: 'Session tabs', mimeType: 'application/json' }, async (uri) => { let tabs: unknown = []; try { tabs = await (await api.agent.browsers.getDefault()).tabs.list(); } catch { /* none */ } return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(tabs, null, 2) }] }; });
  server.registerResource('doctor', 'opencli://doctor', { title: 'Doctor', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(rt.doctor(), null, 2) }] }));

  // ── prompts ──
  server.registerPrompt('browse', { title: 'Browse a site for a goal', description: 'Structured plan: prefer site tools, then observe → act → observe, finalize.', argsSchema: { goal: z.string(), url: z.string().optional() } }, ({ goal, url }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Goal: ${goal}${url ? `\nStart at: ${url}` : ''}\n\n1. sites_search for an existing command that covers the goal; if found, sites_enable and use it.\n2. Otherwise session_name, tab_open, then loop tab_observe → tab_act, reading match_level and error codes.\n3. Confirm before irreversible actions. Finish with session_finalize, keeping only deliverable/handoff tabs.` } }] }));
  server.registerPrompt('write-tool', { title: 'Turn a flow into a tool', description: 'Explore, discover the API, verify, then tools_define.', argsSchema: { site: z.string(), goal: z.string() } }, ({ site, goal }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Create a reusable ${site} tool for: ${goal}\n\n1. Open the site, arm tab_network, perform the flow once.\n2. recon_discover to list endpoint candidates; verify the best one with tab_evaluate (fetch) or js (page.fetchJson).\n3. tools_compile with inputs for the values you typed; review the draft; tools_define it; run it once to verify.` } }] }));

  return {
    server, api,
    close: async () => { rt.off('tools-changed', onToolsChanged); rt.off('log', onLog); rt.off('browser-event', onBrowserEvent); await rt.closeSession(sessionId); },
  };
}
