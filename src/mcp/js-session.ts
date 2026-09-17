/**
 * Persistent JavaScript session (code mode): the same object model as the typed tools, but the
 * agent composes many steps in one call. Top-level const/let become session globals so handles
 * survive across calls; the last expression's value is returned.
 */
import vm from 'node:vm';

export interface JsRunResult { value: unknown; writes: string[]; images: Array<{ mimeType: string; base64: string }>; error?: { name: string; message: string; stack?: string } }
export interface JsImage { mimeType?: string; base64?: string; bytes?: Uint8Array | ArrayBuffer }

const STATEMENT_KEYWORDS = /^(return|if|else|for|while|do|switch|try|catch|finally|throw|const|let|var|function|class|import|export|break|continue|\}|\/\/|\/\*|\*)/;

/** Mask strings/template literals/comments so bracket depth tracking ignores their contents. */
function maskCode(code: string): string {
  let out = ''; let i = 0; const n = code.length;
  while (i < n) {
    const c = code[i]; const next = code[i + 1];
    if (c === '/' && next === '/') { while (i < n && code[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && next === '*') { while (i < n && !(code[i] === '*' && code[i + 1] === '/')) { out += code[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += q; i++;
      while (i < n && code[i] !== q) { if (code[i] === '\\') { out += '  '; i += 2; continue; } out += code[i] === '\n' ? '\n' : ' '; i++; }
      out += q; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

/** Rewrite top-level declarations to assignments and return the last top-level expression. */
export function transformCode(code: string): string {
  const masked = maskCode(code);
  const lines = code.split('\n'); const maskedLines = masked.split('\n');
  let depth = 0; const topLevel: boolean[] = [];
  for (const ml of maskedLines) {
    topLevel.push(depth === 0);
    for (const ch of ml) { if (ch === '{' || ch === '(' || ch === '[') depth++; else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1); }
  }
  const out = lines.map((line, idx) => {
    if (!topLevel[idx]) return line;
    const m = /^(\s*)(const|let|var)\s+(.*)$/.exec(line);
    if (!m) return line;
    const rest = m[3];
    if (/^[{[]/.test(rest)) {
      // destructuring: const {a, b} = expr;  →  ({a, b} = expr);
      const eq = rest.indexOf('=');
      if (eq > 0) { const body = rest.replace(/;\s*$/, ''); return `${m[1]}(${body});`; }
    }
    return `${m[1]}${rest}`;
  });
  // last top-level non-empty line → return its value when it is an expression
  for (let idx = out.length - 1; idx >= 0; idx--) {
    const t = out[idx].trim();
    if (!t) continue;
    if (!topLevel[idx]) break;
    if (STATEMENT_KEYWORDS.test(t) || t.endsWith('{') || t.startsWith('(') && maskedLines[idx].trim().startsWith('({')) break;
    if (/^[A-Za-z_$][\w$]*\s*=[^=]/.test(t)) { // assignment: return the assigned value too
      const name = t.split('=')[0].trim(); out.push(`return ${name};`); break;
    }
    out[idx] = `return (${t.replace(/;\s*$/, '')});`;
    break;
  }
  return out.join('\n');
}

export class JsSession {
  private context: vm.Context;
  private writes: string[] = [];
  private images: Array<{ mimeType: string; base64: string }> = [];
  runs = 0;

  constructor(private readonly globals: Record<string, unknown>) {
    this.context = this.makeContext();
  }

  private makeContext(): vm.Context {
    const self = this;
    const fmt = (v: unknown): string => typeof v === 'string' ? v : safeStringify(v);
    const nodeRepl = {
      write: (v: unknown) => { self.writes.push(fmt(v)); },
      emitImage: async (img: JsImage) => { self.images.push(normalizeImage(img)); },
    };
    const consoleShim = {
      log: (...a: unknown[]) => self.writes.push(a.map(fmt).join(' ')),
      info: (...a: unknown[]) => self.writes.push(a.map(fmt).join(' ')),
      warn: (...a: unknown[]) => self.writes.push('[warn] ' + a.map(fmt).join(' ')),
      error: (...a: unknown[]) => self.writes.push('[error] ' + a.map(fmt).join(' ')),
      debug: () => {},
    };
    return vm.createContext({
      ...this.globals,
      nodeRepl, console: consoleShim,
      setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
      URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone, fetch, AbortController, Headers, Request, Response,
      Buffer, atob, btoa, crypto: globalThis.crypto,
    }, { name: 'opencli-mcp js session' });
  }

  reset(): void { this.context = this.makeContext(); this.runs = 0; }

  async run(code: string, opts: { timeoutMs?: number } = {}): Promise<JsRunResult> {
    this.writes = []; this.images = [];
    const body = transformCode(code);
    const wrapped = `(async () => {\n${body}\n})()`;
    const timeoutMs = opts.timeoutMs ?? 300_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      const script = new vm.Script(wrapped, { filename: `js-call-${++this.runs}.js` });
      const promise = script.runInContext(this.context) as Promise<unknown>;
      const value = await Promise.race([promise, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`js call timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs); })]);
      const images = [...this.images];
      let out = value;
      if (isImageValue(value)) { images.push({ mimeType: value.mimeType, base64: value.base64 }); out = { image: `${value.mimeType} (${Math.round(value.base64.length * 0.75 / 1024)} KB)` }; }
      return { value: out, writes: [...this.writes], images };
    } catch (err) {
      const e = err as Error & { code?: string; hint?: string };
      return { value: undefined, writes: [...this.writes], images: [...this.images], error: { name: e.name ?? 'Error', message: e.message ?? String(err), stack: e.stack?.split('\n').slice(0, 4).join('\n') } };
    } finally { if (timer) clearTimeout(timer); }
  }
}

function isImageValue(v: unknown): v is { __image: true; mimeType: string; base64: string } {
  return Boolean(v && typeof v === 'object' && (v as { __image?: boolean }).__image === true && typeof (v as { base64?: unknown }).base64 === 'string');
}

function normalizeImage(img: JsImage): { mimeType: string; base64: string } {
  const mimeType = img.mimeType ?? 'image/png';
  if (img.base64) return { mimeType, base64: img.base64 };
  if (img.bytes) return { mimeType, base64: Buffer.from(img.bytes instanceof ArrayBuffer ? new Uint8Array(img.bytes) : img.bytes).toString('base64') };
  throw new Error('emitImage expects { base64 } or { bytes }');
}

export function safeStringify(v: unknown, limit = 200_000): string {
  const seen = new WeakSet<object>();
  let s: string;
  try {
    s = JSON.stringify(v, (_k, val) => {
      if (typeof val === 'bigint') return val.toString();
      if (typeof val === 'function') return `[function ${val.name || 'anonymous'}]`;
      if (val && typeof val === 'object') { if (seen.has(val)) return '[circular]'; seen.add(val); }
      return val;
    }, 2) ?? String(v);
  } catch { s = String(v); }
  return s.length > limit ? `${s.slice(0, limit)}\n…(truncated ${s.length - limit} chars)` : s;
}
