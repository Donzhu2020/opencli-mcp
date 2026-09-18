/**
 * opencli-mcp host ⇄ extension protocol.
 *
 * Transport: Chrome Native Messaging (4-byte LE length + JSON) between the
 * Chrome-spawned host process and the extension service worker. The host is
 * the MCP server; the extension is the browser runtime that owns the
 * chrome.debugger session, tab leases, tab groups, cursor overlay and badges.
 *
 * Envelope kinds:
 *   host → ext:  { type: 'command', command: Command }
 *   ext → host:  { type: 'hello', ... } | { type: 'result', result: Result } | { type: 'event', event: BrowserEvent }
 */

export type Action =
  // page control (superset of OpenCLI's bridge actions so the page semantics port cleanly)
  | 'exec' | 'navigate' | 'tabs' | 'cookies' | 'screenshot'
  | 'set-file-input' | 'insert-text' | 'network-capture-start' | 'network-capture-read'
  | 'wait-download' | 'cdp' | 'frames'
  // session & tab-lifecycle (Codex-style: name, claim, finalize)
  | 'session-name' | 'session-finalize' | 'user-tabs' | 'claim' | 'mark'
  // native JavaScript dialogs (alert/confirm/prompt/beforeunload) block the page; the agent sees and answers them explicitly
  | 'dialog'
  // reload/back/forward driven by the browser (evaluating location.reload() never returns: the context dies mid-call)
  | 'history'
  // console messages and uncaught exceptions of the tab, captured while attached (the plugin's tab.dev.logs)
  | 'console'
  // atomic interaction at the runtime edge: locate → wait actionable → hit-test → real input → settle
  | 'act'
  // human visibility
  | 'cursor' | 'visibility' | 'ping';

export interface Command {
  id: string;
  action: Action;
  /** Logical session (one MCP session ⇄ one named tab group). */
  session?: string;
  /** Surface policy: interactive browser session vs. background adapter run. */
  surface?: 'browser' | 'adapter';
  siteSession?: 'ephemeral' | 'persistent';
  /** Target page identity (targetId) for page-scoped commands. */
  page?: string;
  code?: string;
  /** exec: evaluate in the page's main world (default) or in the engine's isolated world */
  world?: 'main' | 'engine';
  url?: string;
  op?: 'list' | 'new' | 'close' | 'select';
  dialogOp?: 'get' | 'accept' | 'dismiss';
  historyOp?: 'reload' | 'back' | 'forward';
  /** console read: cursor paging */
  afterSequence?: number;
  limit?: number;
  levels?: string[];
  filter?: string;
  index?: number;
  domain?: string;
  format?: 'png' | 'jpeg';
  quality?: number;
  fullPage?: boolean;
  width?: number;
  height?: number;
  files?: string[];
  selector?: string;
  text?: string;
  pattern?: string;
  timeoutMs?: number;
  cdpMethod?: string;
  cdpParams?: Record<string, unknown>;
  windowMode?: 'foreground' | 'background';
  frameIndex?: number;
  timeout?: number;
  deadlineAt?: number;
  /** session-name */
  name?: string;
  /** claim: a user tab by id (from user-tabs), or by url/title when the id is omitted; url/title given with an id are guards */
  claim?: { tabId?: number; title?: string; url?: string };
  /** mark / finalize */
  mark?: 'deliverable' | 'handoff' | null;
  keep?: Array<{ page: string; status: 'deliverable' | 'handoff' }>;
  /** cursor */
  x?: number;
  y?: number;
  waitForArrival?: boolean;
  /** visibility */
  visible?: boolean;
  /** act */
  act?: ActSpec;
}

export type ActKind = 'click' | 'dblclick' | 'hover' | 'focus' | 'fill' | 'type' | 'press' | 'check' | 'uncheck' | 'select' | 'scroll' | 'upload' | 'drag';
export interface ActTarget { ref?: number | string; /** raw Playwright selector, e.g. the `selector` returned by find */ selector?: string; /** scope: selector of a container, or an eN ref — the target is resolved inside it (generic labels are ambiguous by default; scope them) */ within?: string; nth?: number; role?: string; name?: string; label?: string; text?: string; testid?: string; x?: number; y?: number; /** iframe(s) to enter first, outermost first: css selector of the <iframe> or its 0-based index; a string may chain with ' >> ' (Codex enter-frame); same- and cross-origin frames are handled alike */ frame?: FrameStep | FrameStep[] }
export type FrameStep = string | number;
export interface ActSpec {
  kind: ActKind;
  target: ActTarget;
  value?: string;
  timeoutMs?: number;
  settleMs?: number;
  cursor?: boolean;
  force?: boolean;
  /** scroll */
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  /** upload */
  files?: string[];
  /** drag */
  to?: ActTarget;
}
/** A native JavaScript dialog currently blocking a tab. */
export interface DialogInfo { type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; defaultPrompt?: string; url?: string; openedAt: number }

export interface ConsoleEntry { seq: number; level: 'debug' | 'info' | 'log' | 'warn' | 'error'; message: string; timestamp: string; url?: string; line?: number }

export interface ActResult {
  ok: true;
  kind: ActKind;
  ref?: string | null;
  matches_n: number;
  visible_n: number;
  match_level: 'exact';
  point: { x: number; y: number };
  method: 'cdp' | 'dom';
  hit: 'target' | 'ancestor' | 'other';
  tag: string;
  /** ms spent resolving the target (visible/enabled/stable/hit-test) */
  waitedMs: number;
  /** end-to-end ms and its breakdown: resolve → dispatch (input events + verification) → settle (DOM quiet wait) */
  elapsedMs?: number;
  timings?: { resolveMs: number; actionMs: number; settleMs: number };
  /** Playwright-generated selector for replay (tools_compile) */
  selector?: string;
  /** set when the action triggered a navigation that has now finished */
  navigated?: boolean;
  url?: string;
  filled?: boolean; verified?: boolean; actual?: string; checked?: boolean; changed?: boolean; key?: string;
}

export interface Result {
  id: string;
  ok: boolean;
  /** result payload on success; structured error details (e.g. candidates) on failure */
  data?: unknown;
  error?: string;
  errorCode?: string;
  errorHint?: string;
  page?: string;
}

export type BrowserEvent =
  | { kind: 'tab_created' | 'tab_acquired' | 'tab_closed'; session: string; page?: string; tabId: number; url?: string; title?: string; origin?: 'agent' | 'user' }
  | { kind: 'download'; state: string; filename?: string; url?: string }
  | { kind: 'dialog'; page?: string; dialogType: string; message?: string }
  | { kind: 'webmcp_changed'; page?: string }
  | { kind: 'session_released'; session: string; reason: string };

export type HostToExt = { type: 'command'; command: Command } | { type: 'ready'; version: string; port: number };
export type ExtToHost =
  | { type: 'hello'; extensionVersion: string; protocolVersion: number; contextId?: string }
  | { type: 'result'; result: Result }
  | { type: 'event'; event: BrowserEvent };

export const PROTOCOL_VERSION = 1;
export const NATIVE_HOST_NAME = 'com.opencli.mcp';
/** Chrome caps host → extension frames at 1 MiB. */
export const MAX_FRAME_BYTES = 1024 * 1024;
