/**
 * JsAnalyzer — syntax-aware extraction of URLs/endpoints and suspected secrets from JavaScript.
 * A JavaScript port of the core ideas of BishopFox/jsluice (MIT) on web-tree-sitter:
 * look where URLs are *used* (fetch/XHR/jQuery/axios/location/WebSocket…), resolve string
 * concatenation and template literals, and replace unknown expressions with `EXPR`.
 * The parser is error-tolerant, so minified or truncated bundles still yield candidates.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { Parser, Language, type Node, type Tree } from 'web-tree-sitter';

export const EXPR = 'EXPR';

export interface UrlMatch {
  url: string;
  method: string;
  type: string;
  queryParams: string[];
  bodyParams: string[];
  headers?: Record<string, string>;
  contentType?: string;
  kind: 'api' | 'asset' | 'page' | 'unknown';
  line: number;
  source: string;
  filename?: string;
}

export interface SecretMatch {
  kind: string;
  key?: string;
  /** Redacted: first 4 characters + ellipsis. Never the full value. */
  preview: string;
  severity: 'info' | 'low' | 'medium' | 'high';
  line: number;
  filename?: string;
}

export interface AnalyzeResult { urls: UrlMatch[]; secrets: SecretMatch[]; parseErrors: boolean }

const HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ASSET_EXT = /\.(js|mjs|cjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|map|json|html?)$/i;
const FILE_EXT = new Set(['js', 'css', 'html', 'htm', 'xhtml', 'xlsx', 'xls', 'docx', 'doc', 'pdf', 'rss', 'xml', 'php', 'phtml', 'asp', 'aspx', 'asmx', 'ashx', 'cgi', 'pl', 'rb', 'py', 'do', 'jsp', 'jspa', 'json', 'jsonp', 'txt']);

const SECRET_PATTERNS: Array<{ kind: string; re: RegExp; severity: SecretMatch['severity'] }> = [
  { kind: 'aws_access_key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, severity: 'high' },
  { kind: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{36}\b/, severity: 'high' },
  { kind: 'gcp_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: 'medium' },
  { kind: 'slack_token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, severity: 'high' },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, severity: 'medium' },
  { kind: 'private_key', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, severity: 'high' },
];
const SECRET_KEY_RE = /(api[_-]?key|secret|token|password|passwd|auth|credential|signature|sign[_-]?key)/i;

export function maybeUrl(s: string): boolean {
  if (!s || s.length > 2048) return false;
  if (!/[/?.]/.test(s)) return false;
  if (/[ ()!<>'"`{}^$,\n\r\t]/.test(s)) return false;
  if (s.startsWith('/')) return !s.startsWith('//') || /^\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(s);
  let u: URL;
  try { u = new URL(s.includes('://') ? s : `http://placeholder.invalid/${s}`); } catch { return false; }
  if (s.includes('://')) {
    const scheme = u.protocol.replace(':', '').toLowerCase();
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ws' && scheme !== 'wss') return false;
    return u.hostname.split('.').length > 1;
  }
  // bare host like api.example.com/path
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/|$)/i.test(s)) return true;
  for (const [, v] of u.searchParams) if (v) return true;
  const ext = s.split('?')[0].split('.').pop() ?? '';
  return s.includes('.') && FILE_EXT.has(ext.toLowerCase());
}

export function decodeString(raw: string): string {
  let s = raw;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) || (s.startsWith('`') && s.endsWith('`'))) s = s.slice(1, -1);
  return s
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(['"`\\])/g, '$1');
}

function classify(url: string, type: string): UrlMatch['kind'] {
  const pathOnly = url.split('?')[0];
  if (ASSET_EXT.test(pathOnly)) return 'asset';
  if (['fetch', 'xhr', 'jquery', 'axios', 'httpClient', 'sendBeacon', 'websocket', 'eventsource', 'request'].includes(type)) return 'api';
  if (/\/(api|v\d+|graphql|rest|ajax|rpc|gateway|services?)\b/i.test(pathOnly)) return 'api';
  if (type === 'locationAssignment' || type === 'windowOpen') return 'page';
  return 'unknown';
}

export class JsAnalyzer {
  private static langPromise: Promise<Language> | null = null;
  private constructor(private readonly parser: Parser) {}

  static async create(): Promise<JsAnalyzer> {
    if (!JsAnalyzer.langPromise) {
      JsAnalyzer.langPromise = (async () => {
        await Parser.init();
        const require = createRequire(import.meta.url);
        const wasm = path.join(path.dirname(require.resolve('tree-sitter-javascript/package.json')), 'tree-sitter-javascript.wasm');
        return Language.load(wasm);
      })();
    }
    const lang = await JsAnalyzer.langPromise;
    const parser = new Parser();
    parser.setLanguage(lang);
    return new JsAnalyzer(parser);
  }

  analyze(source: string, opts: { filename?: string; maxBytes?: number } = {}): AnalyzeResult {
    const max = opts.maxBytes ?? 8 * 1024 * 1024;
    const text = source.length > max ? source.slice(0, max) : source;
    const tree = this.parser.parse(text);
    if (!tree) return { urls: [], secrets: [], parseErrors: true };
    const urls: UrlMatch[] = [];
    const secrets: SecretMatch[] = [];
    const seen = new Set<string>();
    const push = (m: Omit<UrlMatch, 'kind' | 'filename'> | null) => {
      if (!m) return;
      const url = decodeString(m.url);
      const lower = url.toLowerCase();
      if (/^(data|tel|about|javascript|mailto|blob|chrome|chrome-extension):/.test(lower)) return;
      if (url.replace(/[^A-Za-z]/g, '').replaceAll(EXPR, '') === '') return;
      const key = `${m.method}|${m.type}|${url}`;
      if (seen.has(key)) return;
      seen.add(key);
      const qp = new Set(m.queryParams);
      try {
        const u = new URL(url.replaceAll(EXPR, 'expr'), 'http://placeholder.invalid/');
        for (const k of u.searchParams.keys()) qp.add(k);
      } catch { /* ignore */ }
      urls.push({ ...m, url, queryParams: [...qp].sort(), bodyParams: [...new Set(m.bodyParams)].sort(), kind: classify(url, m.type), filename: opts.filename });
    };
    this.walk(tree, (n) => {
      switch (n.type) {
        case 'string': case 'template_string': this.matchString(n, push); break;
        case 'call_expression': this.matchCall(n, push); break;
        case 'new_expression': this.matchNew(n, push); break;
        case 'assignment_expression': this.matchAssignment(n, push); break;
        case 'pair': this.matchPairSecret(n, secrets, opts.filename); break;
      }
      if (n.type === 'string' || n.type === 'template_string') this.matchStringSecret(n, secrets, opts.filename);
    });
    return { urls, secrets, parseErrors: tree.rootNode.hasError };
  }

  private walk(tree: Tree, visit: (n: Node) => void): void {
    const stack: Node[] = [tree.rootNode];
    while (stack.length) {
      const n = stack.pop()!;
      visit(n);
      for (let i = n.childCount - 1; i >= 0; i--) { const c = n.child(i); if (c) stack.push(c); }
    }
  }

  /** Resolve a node to a string, substituting EXPR for anything unknown. */
  resolve(n: Node | null): string {
    if (!n) return EXPR;
    switch (n.type) {
      case 'string': return decodeString(n.text);
      case 'template_string': {
        let out = '';
        for (const c of n.children) {
          if (!c) continue;
          if (c.type === 'string_fragment') out += c.text;
          else if (c.type === 'template_substitution') out += EXPR;
          else if (c.type === 'escape_sequence') out += decodeString(`"${c.text}"`);
        }
        return out;
      }
      case 'binary_expression': {
        const op = n.childForFieldName('operator')?.text ?? n.children.find((c) => c && !c.isNamed)?.text;
        if (op !== '+') return EXPR;
        return this.resolve(n.childForFieldName('left')) + this.resolve(n.childForFieldName('right'));
      }
      case 'parenthesized_expression': return this.resolve(n.namedChildren[0] ?? null);
      case 'number': return n.text;
      default: return EXPR;
    }
  }

  private objectKeys(n: Node | null): string[] {
    if (!n || n.type !== 'object') return [];
    const keys: string[] = [];
    for (const c of n.namedChildren) {
      if (!c) continue;
      if (c.type === 'pair') { const k = c.childForFieldName('key'); if (k) keys.push(decodeString(k.text)); }
      else if (c.type === 'shorthand_property_identifier') keys.push(c.text);
    }
    return keys;
  }

  private objectPairs(n: Node | null): Map<string, Node> {
    const out = new Map<string, Node>();
    if (!n || n.type !== 'object') return out;
    for (const c of n.namedChildren) {
      if (c?.type !== 'pair') continue;
      const k = c.childForFieldName('key'); const v = c.childForFieldName('value');
      if (k && v) out.set(decodeString(k.text), v);
    }
    return out;
  }

  private bodyParams(v: Node | null | undefined): string[] {
    if (!v) return [];
    if (v.type === 'object') return this.objectKeys(v);
    if (v.type === 'call_expression') {
      const fn = v.childForFieldName('function')?.text ?? '';
      const arg0 = v.childForFieldName('arguments')?.namedChildren[0] ?? null;
      if (/JSON\.stringify$/.test(fn) || /URLSearchParams$/.test(fn) || /FormData$/.test(fn)) return this.objectKeys(arg0);
    }
    if (v.type === 'new_expression') {
      const arg0 = v.childForFieldName('arguments')?.namedChildren[0] ?? null;
      return this.objectKeys(arg0);
    }
    if (v.type === 'string' || v.type === 'template_string') {
      const s = this.resolve(v);
      const keys: string[] = [];
      for (const part of s.split('&')) { const k = part.split('=')[0]; if (k && k !== EXPR && !k.includes('{')) keys.push(k); }
      return keys;
    }
    return [];
  }

  private line(n: Node): number { return n.startPosition.row + 1; }
  private src(n: Node): string { const t = n.text; return t.length > 200 ? t.slice(0, 200) + '…' : t; }

  private matchString(n: Node, push: (m: Omit<UrlMatch, 'kind' | 'filename'> | null) => void): void {
    // Only free-standing literals; strings that are arguments to matched calls are handled there (dedupe keeps one).
    const parent = n.parent;
    if (parent && (parent.type === 'pair' || parent.type === 'arguments' || parent.type === 'binary_expression' || parent.type === 'assignment_expression')) {
      // still consider object values like { url: "/api/x" }
      if (parent.type === 'pair') {
        const key = parent.childForFieldName('key')?.text.replace(/['"]/g, '') ?? '';
        if (!/^(url|uri|href|endpoint|path|action|baseURL|baseUrl|base_url|api|apiUrl|apiBase|host|origin)$/i.test(key)) return;
      } else return;
    }
    const val = this.resolve(n);
    if (!maybeUrl(val)) return;
    push({ url: val, method: 'GET', type: 'string', queryParams: [], bodyParams: [], line: this.line(n), source: this.src(n) });
  }

  private matchCall(n: Node, push: (m: Omit<UrlMatch, 'kind' | 'filename'> | null) => void): void {
    const fnNode = n.childForFieldName('function');
    const args = n.childForFieldName('arguments');
    if (!fnNode || !args) return;
    const fn = fnNode.text;
    const a = args.namedChildren.filter((c): c is Node => Boolean(c));
    const base = { line: this.line(n), source: this.src(n), queryParams: [] as string[], bodyParams: [] as string[] };

    if (fn === 'fetch' || fn.endsWith('.fetch')) {
      const url = this.resolve(a[0] ?? null);
      if (!maybeUrl(url) && !url.includes(EXPR)) return;
      const opts = this.objectPairs(a[1] ?? null);
      const method = opts.get('method') ? this.resolve(opts.get('method')!).toUpperCase() : 'GET';
      const headers: Record<string, string> = {};
      for (const [k, v] of this.objectPairs(opts.get('headers') ?? null)) headers[k] = this.resolve(v);
      push({ ...base, url, method: HTTP_METHODS.has(method) ? method : 'GET', type: 'fetch', bodyParams: this.bodyParams(opts.get('body')), headers: Object.keys(headers).length ? headers : undefined, contentType: headers['Content-Type'] ?? headers['content-type'] });
      return;
    }
    if (fn.endsWith('.open') && a.length >= 2) {
      const method = decodeString(a[0].text).toUpperCase();
      if (!HTTP_METHODS.has(method)) return;
      push({ ...base, url: this.resolve(a[1]), method, type: 'xhr' });
      return;
    }
    const jq = /^(?:\$|jQuery)\.(ajax|get|post|getJSON|put|delete)$/.exec(fn);
    if (jq) {
      const verb = jq[1];
      if (verb === 'ajax') {
        const opts = this.objectPairs(a[0] ?? null);
        const url = opts.get('url') ? this.resolve(opts.get('url')!) : EXPR;
        const method = (opts.get('type') ?? opts.get('method')) ? this.resolve((opts.get('type') ?? opts.get('method'))!).toUpperCase() : 'GET';
        push({ ...base, url, method: HTTP_METHODS.has(method) ? method : 'GET', type: 'jquery', bodyParams: this.bodyParams(opts.get('data')) });
      } else {
        const method = verb === 'post' ? 'POST' : verb === 'put' ? 'PUT' : verb === 'delete' ? 'DELETE' : 'GET';
        const params = this.bodyParams(a[1]);
        push({ ...base, url: this.resolve(a[0] ?? null), method, type: 'jquery', ...(method === 'GET' ? { queryParams: params } : { bodyParams: params }) });
      }
      return;
    }
    const ax = /^axios(?:\.(get|post|put|patch|delete|head|options|request))?$/.exec(fn);
    if (ax) {
      if (ax[1] && ax[1] !== 'request') {
        const method = ax[1].toUpperCase();
        const params = this.bodyParams(a[1]);
        push({ ...base, url: this.resolve(a[0] ?? null), method, type: 'axios', ...(method === 'GET' || method === 'DELETE' ? { queryParams: this.objectKeys(this.objectPairs(a[1] ?? null).get('params') ?? null) } : { bodyParams: params }) });
      } else {
        const opts = this.objectPairs(a[0] ?? null);
        const url = opts.get('url') ? this.resolve(opts.get('url')!) : this.resolve(a[0] ?? null);
        const method = opts.get('method') ? this.resolve(opts.get('method')!).toUpperCase() : 'GET';
        push({ ...base, url, method: HTTP_METHODS.has(method) ? method : 'GET', type: 'axios', queryParams: this.objectKeys(opts.get('params') ?? null), bodyParams: this.bodyParams(opts.get('data')) });
      }
      return;
    }
    const client = /\.(get|post|put|patch|delete|request)$/.exec(fn);
    if (client && a[0] && (a[0].type === 'string' || a[0].type === 'template_string' || a[0].type === 'binary_expression')) {
      const url = this.resolve(a[0]);
      if (!(url.startsWith('/') || /^https?:\/\//.test(url) || url.startsWith(EXPR + '/'))) return;
      const method = client[1] === 'request' ? 'GET' : client[1].toUpperCase();
      push({ ...base, url, method, type: 'httpClient', bodyParams: method === 'GET' ? [] : this.bodyParams(a[1]) });
      return;
    }
    if (fn === 'window.open' || fn === 'open' || fn === 'location.assign' || fn === 'location.replace' || fn.endsWith('.location.assign') || fn.endsWith('.location.replace')) {
      const url = this.resolve(a[0] ?? null);
      if (maybeUrl(url) || url.includes(EXPR)) push({ ...base, url, method: 'GET', type: 'windowOpen' });
      return;
    }
    if (fn === 'navigator.sendBeacon' || fn.endsWith('.sendBeacon')) {
      push({ ...base, url: this.resolve(a[0] ?? null), method: 'POST', type: 'sendBeacon', bodyParams: this.bodyParams(a[1]) });
    }
  }

  private matchNew(n: Node, push: (m: Omit<UrlMatch, 'kind' | 'filename'> | null) => void): void {
    const ctor = n.childForFieldName('constructor')?.text ?? '';
    const a = n.childForFieldName('arguments')?.namedChildren.filter((c): c is Node => Boolean(c)) ?? [];
    const base = { line: this.line(n), source: this.src(n), queryParams: [] as string[], bodyParams: [] as string[] };
    if (/(^|\.)WebSocket$/.test(ctor)) push({ ...base, url: this.resolve(a[0] ?? null), method: 'GET', type: 'websocket' });
    else if (/(^|\.)EventSource$/.test(ctor)) push({ ...base, url: this.resolve(a[0] ?? null), method: 'GET', type: 'eventsource' });
    else if (/(^|\.)Request$/.test(ctor)) {
      const opts = this.objectPairs(a[1] ?? null);
      const method = opts.get('method') ? this.resolve(opts.get('method')!).toUpperCase() : 'GET';
      push({ ...base, url: this.resolve(a[0] ?? null), method: HTTP_METHODS.has(method) ? method : 'GET', type: 'request', bodyParams: this.bodyParams(opts.get('body')) });
    } else if (/(^|\.)URL$/.test(ctor) && a[0]) {
      const url = this.resolve(a[0]);
      if (maybeUrl(url) || url.includes(EXPR)) push({ ...base, url, method: 'GET', type: 'urlConstructor' });
    }
  }

  private matchAssignment(n: Node, push: (m: Omit<UrlMatch, 'kind' | 'filename'> | null) => void): void {
    const left = n.childForFieldName('left')?.text ?? '';
    if (!/(^|\.)(location|location\.href|src|href|action)$/.test(left)) return;
    const url = this.resolve(n.childForFieldName('right'));
    if (!maybeUrl(url) && !url.includes(EXPR)) return;
    push({ url, method: 'GET', type: 'locationAssignment', queryParams: [], bodyParams: [], line: this.line(n), source: this.src(n) });
  }

  private matchPairSecret(n: Node, out: SecretMatch[], filename?: string): void {
    const k = n.childForFieldName('key'); const v = n.childForFieldName('value');
    if (!k || !v || (v.type !== 'string' && v.type !== 'template_string')) return;
    const key = decodeString(k.text);
    if (!SECRET_KEY_RE.test(key)) return;
    const val = this.resolve(v);
    if (val.length < 12 || val.includes(EXPR) || /^(true|false|null|undefined)$/i.test(val) || maybeUrl(val)) return;
    out.push({ kind: 'keyed_secret', key, preview: `${val.slice(0, 4)}…(${val.length})`, severity: 'low', line: this.line(n), filename });
  }

  private matchStringSecret(n: Node, out: SecretMatch[], filename?: string): void {
    const val = this.resolve(n);
    if (val.length < 16 || val.includes(EXPR)) return;
    for (const p of SECRET_PATTERNS) {
      const m = p.re.exec(val);
      if (m) { out.push({ kind: p.kind, preview: `${m[0].slice(0, 4)}…(${m[0].length})`, severity: p.severity, line: this.line(n), filename }); return; }
    }
  }
}
