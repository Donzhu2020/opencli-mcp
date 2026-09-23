## API reference (generated from src/api/{api,browser,tab}.ts — do not edit)

In `js` the globals are `agent`, `sites`, `recon`, `tools`, `session` (the members of `AgentApi`) plus `nodeRepl` and `Tab`. Everything below is the whole model-facing surface; typed entry tools are projections of it.

```ts
interface AgentApi {
  agent: { browsers: { getDefault(): Promise<Browser>; }; browser: Browser; documentation: { get(name: string): string | null; }; };
  sites: Record<string, unknown> & { search(q: string, limit?: number): Promise<unknown>; list(): unknown; enable(site: string, opts?: { write?: boolean; }): Promise<{ site: string; tools: Array<string>; }>; disable(site: string): boolean; run(site: string, name: string, args?: Record<string, unknown>): Promise<unknown>; };
  recon: {
    discover(tab: Tab, opts?: { maxScripts?: number; includeAssets?: boolean; includeInline?: boolean; fetchTimeoutMs?: number; network?: Array<Record<string, unknown>>; }): Promise<DiscoverResult>;
  };
  tools: {
    define(def: ToolDefinition | (Omit<ToolDefinition, "func"> & { func?: string | ((ctx: Record<string, unknown>) => unknown); })): Promise<{ file: string; site: string; name: string; }>;
    list(): Array<{ site: string; name: string; file: string; }>;
    remove(site: string, name: string): boolean;
  };
  session: { id: string; };
}

class Browser {
  id: "chrome";
  type: "extension";
  tabs: {
    new(url?: string): Promise<Tab>;
    list(): Promise<Array<{ id: string; url?: string; title?: string; active: boolean; selected: boolean; origin: "agent" | "user"; state: "active" | "handoff"; }>>;
    get(id: string): Tab;
    selected(): Promise<Tab | undefined>;
    finalize(opts?: { keep?: Array<{ tab: string | Tab; status: "handoff" | "deliverable"; }>; }): Promise<{ closed: Array<string>; kept: Array<string>; failed: Array<{ page: string; reason: string; }>; }>;
  };
  user: {
    openTabs(options?: { query?: string; limit?: number; }): Promise<Array<UserTabInfo>>;
    claimTab(tab: { tabId?: number; title?: string; url?: string; }): Promise<Tab>; // Claim a user tab by id, or by url/title (unique match) when the id is omitted; url/title with an id act as guards.
  };
  nameSession(name: string): Promise<void>;
  capabilities: {
    list(): Promise<Array<{ id: string; description: string; }>>;
    get(id: string): Promise<Record<string, unknown>>;
  };
  documentation(): string;
}

class Tab {
  id: string;
  goto(url: string, opts?: { waitUntil?: "load" | "none"; settleMs?: number; }): Promise<{ url: string | null; title: string | null; }>;
  url(): Promise<string | null>;
  title(): Promise<string | null>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>; // Close this tab, whether it was opened or claimed by this session.
  release(): Promise<void>; // Keep this tab open and give up this session's control of it.
  observe(opts?: ObserveOptions): Promise<{ url: string | null; title: string | null; state?: string; diff?: boolean; changed?: { added: number; removed: number; changed?: number; }; image?: ImageValue; }>;
  screenshot(opts?: { fullPage?: boolean; annotate?: boolean; format?: "png" | "jpeg"; quality?: number; }): Promise<ImageValue>;
  find(target: Target & { limit?: number; }): Promise<FindResult | ElementAtResult>;
  read(opts?: ReadOptions): Promise<ReadTextResult>; // Linear text of a bounded document. Scrolls to mount lazy content, dedupes, restores the scroll position. No refs. A feed that grows without a bottom returns reason `unbounded` and the head already read — do not call it again to finish the feed.
  act(opts: ActOptions): Promise<Record<string, unknown>>; // wait + act in one call at the runtime edge: locate → wait actionable → hit-test → real input → settle. `method:'dom'` skips the mouse event.
  webmcp: { // WebMCP: tools the page itself registers via navigator.modelContext (page-provided tool source).
    list(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown; }>>;
    call(name: string, input?: Record<string, unknown>): Promise<unknown>;
  };
  expect(what: Expectation, opts?: { timeoutMs?: number; }): Promise<CheckResult>; // Assert what the page must show now (polled up to timeoutMs).
  evaluate(js: string, opts?: { allowWrite?: boolean; frame?: number; }): Promise<unknown>; // Read-only page evaluation.
  dialog: { // Native alert/confirm/prompt dialogs block the page; commands fail with `dialog_open` until answered.
    get(): Promise<DialogInfo | null>;
    accept(text?: string): Promise<DialogInfo | null>;
    dismiss(): Promise<DialogInfo | null>;
  };
  console: { // Console messages and uncaught exceptions since the tab was attached (the plugin's tab.dev.logs); cursor-paged like network.read.
    read(opts?: { afterSequence?: number; limit?: number; levels?: Array<"debug" | "info" | "log" | "warn" | "error">; filter?: string; }): Promise<{ cursor: number; entries: Array<ConsoleEntry>; hasMore: boolean; }>;
  };
  network: {
    start(pattern?: string): Promise<boolean>;
    read(opts?: { pattern?: string; limit?: number; includeStatic?: boolean; afterSequence?: number; }): Promise<{ cursor: number; entries: Array<unknown>; hasMore: boolean; }>; // Cursor-paged read: pass `afterSequence` from the previous result to get only new requests. Returns network rows only; endpoint candidates come from the explicit `recon.discover(tab)` (not a hidden side effect of reading).
  };
  cookies(domain: string): Promise<Array<unknown>>;
  cookie(name: string, opts?: { domain?: string; }): Promise<string | undefined>; // Read one cookie's value at run time — useful for per-request tokens an adapter needs (csrf/ct0/ csrftoken/XSRF-TOKEN). Defaults to the current page's host. Returns undefined when the cookie is absent.
  fetchJson(url: string, opts?: Record<string, unknown>): Promise<unknown>; // Fetch JSON through the page (its cookies and origin) after verifying the endpoint.
  frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string; crossOrigin?: boolean; oopif?: boolean; }>>;
  download(pattern?: string, timeoutMs?: number): Promise<unknown>;
}

type Target = ({ frame?: FrameStep | FrameStep[]; within?: string }) & (
  | { ref: number | string }
  | { selector: string; nth?: number }
  | { role?: string; name?: string; label?: string; text?: string; testid?: string; nth?: number }
  | { x: number; y: number });

type ActAction = 'click' | 'dblclick' | 'hover' | 'focus' | 'fill' | 'type' | 'press' | 'select' | 'check' | 'uncheck' | 'upload' | 'drag' | 'scroll' | 'back' | 'forward' | 'reload';

interface ActOptions { target?: Target; action: ActAction; value?: string; files?: string[]; to?: Target; direction?: 'up' | 'down' | 'left' | 'right'; amount?: number; timeoutMs?: number; settleMs?: number; method?: 'cdp' | 'dom' }

interface ObserveOptions { mode?: 'state' | 'screenshot' | 'both'; diff?: boolean; viewport?: boolean; ref?: string; annotate?: boolean; fullPage?: boolean }

interface ReadOptions { maxChars?: number; start?: number }
```
