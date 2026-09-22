/** Stable, branchable errors for the object API and typed tools. */
export class ActionError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string, readonly data?: Record<string, unknown>) {
    super(message);
    this.name = 'ActionError';
  }
  toJSON(): Record<string, unknown> { return { code: this.code, message: this.message, ...(this.hint && { hint: this.hint }), ...this.data }; }
}

// The corpus/adapter layer (OpenCLI) speaks SCREAMING_SNAKE / CamelCase; the object model speaks lowercase snake_case.
// One vocabulary is strictly more agent-friendly, so site errors are normalized to the object-model families here.
const CORPUS_CODE_MAP: Record<string, string> = {
  TIMEOUT: 'timeout',
  COMMAND_EXEC: 'command_failed',
  BROWSER_CONNECT: 'browser_unavailable',
  TARGETERROR: 'not_found',
  VALIDATION: 'invalid_args',
  INVALID_ARGS: 'invalid_args',
  INVALID_ARGUMENT: 'invalid_args',
  NAVIGATION: 'page_not_loaded',
};
/** Map a corpus/adapter error code to the object-model vocabulary; leave already-lowercase codes untouched. */
export function normalizeErrorCode(code: string | undefined | null): string {
  const c = (code ?? '').trim();
  if (!c) return 'error';
  const mapped = CORPUS_CODE_MAP[c.toUpperCase()];
  if (mapped) return mapped;
  if (c === c.toLowerCase()) return c; // already our vocabulary
  return c.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

export function errorEnvelope(err: unknown): { ok: false; error: Record<string, unknown> } {
  if (err instanceof ActionError) {
    const body = err.toJSON();
    return { ok: false, error: { ...body, code: normalizeErrorCode(String(body.code)) } };
  }
  const e = err as { code?: string; message?: string; hint?: string; name?: string; data?: unknown };
  const data = e.data && typeof e.data === 'object' && !Array.isArray(e.data) ? e.data as Record<string, unknown> : {};
  const raw = e.code ?? (e.name === 'BrowserCommandError' ? 'browser_command_failed' : 'error');
  return { ok: false, error: { code: normalizeErrorCode(raw), message: e.message ?? String(err), ...(e.hint && { hint: e.hint }), ...data } };
}
