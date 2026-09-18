## API reference (generated from src/api/{api,browser,tab}.ts — do not edit)

In `js` the globals are `agent`, `sites`, `recon`, `tools`, `session` (the members of `AgentApi`) plus `nodeRepl` and `Tab`. Everything below is the whole model-facing surface; typed entry tools are projections of it.

```ts
interface AgentApi {
  agent: { browsers: { list(): Promise<Array<{ id: string; type: string; connected: boolean; }>>; get(id: string): Promise<Browser>; getDefault(): Promise<Browser>; getForUrl(url: string): Promise<Browser>; }; documentation: { get(name: string): string | null; }; };
  sites: Record<string, unknown> & { search(q: string, limit?: number): unknown; list(): unknown; enable(site: string, opts?: { write?: boolean; }): { site: string; tools: Array<string>; }; disable(site: string): boolean; run(site: string, name: string, args?: Record<string, unknown>): Promise<unknown>; };
  recon: {
    discover(tab: Tab, opts?: { maxScripts?: number; includeAssets?: boolean; includeInline?: boolean; fetchTimeoutMs?: number; network?: Array<Record<string, unknown>>; }): Promise<DiscoverResult>;
  };
  tools: {
    define(def: ToolDefinition | (Omit<ToolDefinition, "func"> & { func?: string | ((ctx: Record<string, unknown>) => unknown); })): Promise<{ file: string; site: string; name: string; }>;
    compile(opts: { site: string; name: string; description: string; access?: "read" | "write"; inputs?: Record<string, CompileInput>; domain?: string; }): ToolDefinition;
    list(): Array<{ site: string; name: string; file: string; }>;
    remove(site: string, name: string): boolean;
  };
  session: {
    id: string;
    allowOrigin(host: string, persist?: boolean): { host: string; persist: boolean; };
    trace(): Array<unknown>;
    clearTrace(): void;
  };
}

class Browser {
  id: "chrome";
  type: "extension";
  tabs: {
    new(url?: string): Promise<Tab>;
    list(): Promise<Array<{ id: string; url?: string; title?: string; active?: boolean; }>>;
    get(id: string): Tab;
    selected(): Promise<Tab | undefined>;
    finalize(opts?: { keep?: Array<{ tab: string | Tab; status: "deliverable" | "handoff"; }>; }): Promise<{ closed: Array<string>; kept: Array<string>; }>;
  };
  user: {
    openTabs(): Promise<Array<UserTabInfo>>;
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
  close(): Promise<void>;
  observe(opts?: ObserveOptions): Promise<{ url: string | null; title: string | null; state?: string; diff?: boolean; changed?: { added: number; removed: number; changed?: number; }; image?: ImageValue; }>;
  screenshot(opts?: { fullPage?: boolean; annotate?: boolean; format?: "png" | "jpeg"; quality?: number; }): Promise<ImageValue>;
  find(target: Target & { limit?: number; }): Promise<FindResult | ElementAtResult>;
  act(opts: ActOptions): Promise<Record<string, unknown>>; // wait + act in one call at the runtime edge: locate → wait actionable → hit-test → real input → settle.
  webmcp: { // WebMCP: tools the page itself registers via navigator.modelContext (page-provided tool source).
    list(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown; }>>;
    call(name: string, input?: Record<string, unknown>, opts?: { confirm?: boolean; }): Promise<unknown>;
  };
  expect(what: Expectation, opts?: { timeoutMs?: number; }): Promise<CheckResult>; // Assert what the page must show now (polled up to timeoutMs). Recorded in the trace so tools_compile emits it as a checkpoint.
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
    read(opts?: { pattern?: string; limit?: number; includeStatic?: boolean; afterSequence?: number; }): Promise<{ cursor: number; entries: Array<unknown>; hasMore: boolean; candidates?: Array<EndpointCandidate>; candidatesPending?: boolean; }>; // Cursor-paged read: pass `afterSequence` from the previous result to get only new requests.
  };
  cookies(domain: string): Promise<Array<unknown>>;
  cookie(name: string, opts?: { domain?: string; }): Promise<string | undefined>; // Read one cookie's value at run time — the replay hook for per-request tokens a frozen tool needs (csrf/ct0/ csrftoken/XSRF-TOKEN). Defaults to the current page's host. Returns undefined when the cookie is absent.
  fetchJson(url: string, opts?: Record<string, unknown>): Promise<unknown>; // Fetch JSON through the page (its cookies, its origin) — the network-first way to freeze a site: find the endpoint, call it directly.
  frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string; crossOrigin?: boolean; oopif?: boolean; }>>;
  download(pattern?: string, timeoutMs?: number): Promise<unknown>;
  markDeliverable(): Promise<void>;
  markHandoff(): Promise<void>;
}

type Target = ({ frame?: FrameStep | FrameStep[]; within?: string }) & (
  | { ref: number | string }
  | { selector: string; nth?: number }
  | { role?: string; name?: string; label?: string; text?: string; testid?: string; nth?: number }
  | { x: number; y: number });

type ActAction = 'click' | 'dblclick' | 'hover' | 'focus' | 'fill' | 'type' | 'press' | 'select' | 'check' | 'uncheck' | 'upload' | 'drag' | 'scroll' | 'back' | 'forward' | 'reload';

interface ActOptions { target?: Target; action: ActAction; value?: string; files?: string[]; to?: Target; direction?: 'up' | 'down' | 'left' | 'right'; amount?: number; timeoutMs?: number; settleMs?: number; confirm?: boolean }

interface ObserveOptions { mode?: 'state' | 'screenshot' | 'both'; diff?: boolean; viewport?: boolean; annotate?: boolean; fullPage?: boolean }
```
