/** Stable, branchable errors for the object API and typed tools. */
export class ActionError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string, readonly data?: Record<string, unknown>) {
    super(message);
    this.name = 'ActionError';
  }
  toJSON(): Record<string, unknown> { return { code: this.code, message: this.message, ...(this.hint && { hint: this.hint }), ...this.data }; }
}

export function errorEnvelope(err: unknown): { ok: false; error: Record<string, unknown> } {
  if (err instanceof ActionError) return { ok: false, error: err.toJSON() };
  const e = err as { code?: string; message?: string; hint?: string; name?: string; data?: unknown };
  const data = e.data && typeof e.data === 'object' && !Array.isArray(e.data) ? e.data as Record<string, unknown> : {};
  return { ok: false, error: { code: e.code ?? (e.name === 'BrowserCommandError' ? 'browser_command_failed' : 'error'), message: e.message ?? String(err), ...(e.hint && { hint: e.hint }), ...data } };
}
