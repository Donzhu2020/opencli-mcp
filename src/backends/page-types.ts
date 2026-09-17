/** The page surface the runtime relies on: OpenCLI's IPage plus the transport-level extras our backends provide. */
import type { IPage, ScreenshotOptions, BrowserDownloadWaitResult } from '@jackwener/opencli/types';
import type { ActSpec, ActResult } from '../protocol.js';

export interface RuntimePage extends IPage {
  getActivePage(): string | undefined;
  setActivePage(page?: string): void;
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  newTab(url?: string): Promise<string | undefined>;
  closeTab(target?: number | string): Promise<void>;
  closeWindow(): Promise<void>;
  screenshot(options?: ScreenshotOptions): Promise<string>;
  annotatedScreenshot(options?: ScreenshotOptions): Promise<string>;
  startNetworkCapture(pattern?: string): Promise<boolean>;
  readNetworkCapture(): Promise<unknown[]>;
  waitForDownload(pattern?: string, timeoutMs?: number): Promise<BrowserDownloadWaitResult>;
  setFileInput(files: string[], selector?: string): Promise<void>;
  insertText(text: string): Promise<void>;
  frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string }>>;
  evaluateInFrame(js: string, frameIndex: number): Promise<unknown>;
  nativeClick(x: number, y: number): Promise<void>;
  nativeType(text: string): Promise<void>;
  nativeKeyPress(key: string, modifiers?: string[]): Promise<void>;
  getCurrentUrl(): Promise<string | null>;
  evaluateWithArgs(js: string, args: Record<string, unknown>): Promise<unknown>;
  /** opencli-mcp extras */
  readonly session: string;
  readonly surface: 'browser' | 'adapter';
  /** The interaction engine at this backend's edge (locate → wait → hit-test → real input → settle). */
  act(spec: ActSpec): Promise<ActResult>;
  /** Evaluate in the engine's world (Playwright injected script available as globalThis.__opencliInjected). */
  engineEvaluate(js: string, timeoutMs?: number): Promise<unknown>;
}
