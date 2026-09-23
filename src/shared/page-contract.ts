/**
 * Contract between the host-side engine (src/shared/engine.ts) and the page-side module
 * (extension/src/page/index.ts) that runs inside the extension's isolated world next to Playwright's
 * InjectedScript. Only plain JSON crosses this boundary: the host calls `globalThis.__opencliPage.<fn>(args)`.
 */
export const ENGINE_GLOBAL = '__opencliInjected';
export const PAGE_GLOBAL = '__opencliPage';
/** Attribute the resolver sets on the element an action is about to touch. */
export const ACT_MARK = 'data-opencli-act';
/** Attribute the frame probe sets on the <iframe> the edge is about to route into. */
export const FRAME_MARK = 'data-opencli-frame';

export interface ResolveArgs {
  selector: string;
  fallback: string | null;
  /** strict: several matches are only accepted when exactly one is visible */
  strict: boolean;
  /** actionability states to require, e.g. ['visible','enabled','editable'] */
  states: string[];
  align: { block: string; inline: string };
}

export interface Candidate { tag: string; role: string; text: string; ref: string | null; visible: boolean; box: Box }
export interface Box { x: number; y: number; w: number; h: number }

export interface Resolved {
  ok: true;
  x: number; y: number;
  matches_n: number;
  tag: string;
  hit: 'target' | 'other';
  blocker: string | null;
  editable: boolean; checkable: boolean; checked: boolean; isSelect: boolean;
  /** aria ref (eN) when the element is in the last aria snapshot */
  ref: string | null;
  /** Playwright-generated selector for replay */
  selector: string | null;
  usedSelector: string;
}
export interface ResolveFail { error: { code: string; message: string; hint?: string; candidates?: Candidate[] }; retry?: boolean }
export type ResolveOutcome = Resolved | ResolveFail;

export interface FindArgs { selector: string; fallback: string | null; limit: number }
export interface FindEntry {
  nth: number;
  ref: string | null;
  selector: string | null;
  tag: string; role: string; name: string; text: string;
  attrs: Record<string, string>;
  visible: boolean; enabled: boolean | null; editable: boolean | null;
  box: Box;
}
export interface FindResult { matches_n: number; visible_n: number; selector: string; entries: FindEntry[] }

export interface AriaArgs {
  /** only the subtree of elements intersecting the viewport */
  viewport?: boolean;
  /** open one branch of a previous snapshot (`eN`). Ignores viewport so an off-screen collapsed branch can be read. */
  ref?: string;
  /** character budget before branches with a ref collapse. The host uses the default; tests pass a small one. */
  budget?: number;
}

export interface ReadTextArgs { maxChars?: number; start?: number; maxSteps?: number; waitMs?: number }
/** Linear document text. `nextStart` continues a bounded read on an unchanged page. `unbounded` means a feed grew on every pass. */
export interface ReadTextResult { text: string; complete: boolean; reason?: 'budget' | 'unbounded'; chars: number; start: number; nextStart?: number }

export interface DomClickArgs { selector: string; fallback: string | null }
export interface DomClickOk { ok: true; ref: string | null; tag: string; selector: string | null; x: number; y: number }
export type DomClickResult = DomClickOk | ResolveFail

export interface PointInfo { tag: string; editable: boolean; isSelect: boolean }

export interface FrameProbeResult { found: boolean; sameOrigin?: boolean; x?: number; y?: number; src?: string }

export interface SettleArgs { maxMs: number; quietMs: number }

export interface SelectResult { selected?: string[]; error?: string; available?: string[] }

export interface ElementAtResult { matches_n: number; entries: FindEntry[] }

/** What a flow expects of the page at a step; every field given must hold. */
export interface Expectation { text?: string; notText?: string; selector?: string; ref?: string; url?: string; title?: string; visible?: boolean }
export interface CheckResult { ok: boolean; failed: string[]; url: string; title: string }
