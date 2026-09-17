/**
 * recon.discover — the "static candidates" leg of API discovery.
 * Collects the scripts a live page has loaded, runs the JsAnalyzer over them, and merges the
 * candidates with dynamic network evidence into a ledger: seen-in-network > api-shaped static > other.
 * Candidates are evidence, not contracts: `EXPR` marks unknown dynamic parts.
 */
import { JsAnalyzer, EXPR, type UrlMatch, type SecretMatch } from './analyzer.js';
import type { RuntimePage } from '../backends/page-types.js';

export interface EndpointCandidate {
  url: string;
  method: string;
  type: string;
  kind: UrlMatch['kind'];
  queryParams: string[];
  bodyParams: string[];
  evidence: 'network+static' | 'network' | 'static';
  network?: { status?: number; contentType?: string; count: number };
  sources: Array<{ script: string; line: number; snippet: string }>;
  score: number;
}

export interface DiscoverResult {
  pageUrl: string | null;
  scripts: Array<{ url: string; bytes: number; analyzed: boolean; error?: string }>;
  endpoints: EndpointCandidate[];
  secrets: SecretMatch[];
  networkEntries: number;
}

const THIRD_PARTY_NOISE = /(googletagmanager|google-analytics|doubleclick|facebook\.net|hotjar|sentry|segment\.com|intercom|crazyegg|clarity\.ms|cloudflareinsights|hcaptcha|recaptcha|amazon-adsystem|newrelic|datadoghq)/i;

function normalizeKey(method: string, url: string): string {
  let u = url.replaceAll(EXPR, '*');
  try { const p = new URL(u, 'http://placeholder.invalid/'); u = (p.hostname === 'placeholder.invalid' ? '' : p.hostname) + p.pathname.replace(/\/\d+(?=\/|$)/g, '/*'); } catch { /* keep */ }
  return `${method} ${u}`;
}

export async function discoverEndpoints(page: RuntimePage, opts: { maxScripts?: number; includeAssets?: boolean; includeInline?: boolean; fetchTimeoutMs?: number } = {}): Promise<DiscoverResult> {
  const maxScripts = opts.maxScripts ?? 40;
  const analyzer = await JsAnalyzer.create();
  const pageUrl = await page.getCurrentUrl().catch(() => null);
  const listed = await page.evaluate<Array<{ src: string; inline: string | null }>>(
    `[...document.scripts].map(s => ({ src: s.src || '', inline: s.src ? null : (s.textContent || '').slice(0, 2000000) }))`,
  ).catch(() => [] as Array<{ src: string; inline: string | null }>);

  const scripts: DiscoverResult['scripts'] = [];
  const urls: UrlMatch[] = [];
  const secrets: SecretMatch[] = [];
  let inlineIdx = 0;
  const external = listed.filter((s) => s.src && !THIRD_PARTY_NOISE.test(s.src)).slice(0, maxScripts);
  const inline = opts.includeInline === false ? [] : listed.filter((s) => !s.src && s.inline && s.inline.length > 50);

  for (const s of inline) {
    const name = `inline#${++inlineIdx}`;
    const r = analyzer.analyze(s.inline!, { filename: name });
    scripts.push({ url: name, bytes: s.inline!.length, analyzed: true });
    urls.push(...r.urls); secrets.push(...r.secrets);
  }
  await Promise.all(external.map(async (s) => {
    const entry: DiscoverResult['scripts'][number] = { url: s.src, bytes: 0, analyzed: false };
    scripts.push(entry);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.fetchTimeoutMs ?? 15_000);
      const res = await fetch(s.src, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 (opencli-mcp recon)' } });
      clearTimeout(timer);
      if (!res.ok) { entry.error = `HTTP ${res.status}`; return; }
      const text = await res.text();
      entry.bytes = text.length;
      const r = analyzer.analyze(text, { filename: s.src });
      entry.analyzed = true;
      urls.push(...r.urls); secrets.push(...r.secrets);
    } catch (err) {
      entry.error = (err as Error).message;
    }
  }));

  // Dynamic evidence: network capture (if armed) and performance resource entries.
  const netByKey = new Map<string, { status?: number; contentType?: string; count: number }>();
  let networkEntries = 0;
  const captured = await page.readNetworkCapture().catch(() => [] as unknown[]);
  const perf = await page.networkRequests(false).catch(() => [] as unknown[]);
  for (const e of [...captured, ...perf] as Array<Record<string, unknown>>) {
    const url = String(e.url ?? e.name ?? '');
    if (!url) continue;
    networkEntries++;
    const method = String(e.method ?? 'GET').toUpperCase();
    const key = normalizeKey(method, url);
    const cur = netByKey.get(key) ?? { count: 0 };
    cur.count++;
    if (e.status !== undefined) cur.status = Number(e.status);
    const ct = (e.contentType ?? e.mimeType ?? (e.responseHeaders as Record<string, string> | undefined)?.['content-type']) as string | undefined;
    if (ct) cur.contentType = ct;
    netByKey.set(key, cur);
  }

  const merged = new Map<string, EndpointCandidate>();
  for (const u of urls) {
    if (!opts.includeAssets && u.kind === 'asset') continue;
    const key = normalizeKey(u.method, u.url);
    const net = netByKey.get(key);
    const existing = merged.get(key);
    if (existing) {
      existing.sources.push({ script: u.filename ?? '?', line: u.line, snippet: u.source });
      existing.queryParams = [...new Set([...existing.queryParams, ...u.queryParams])].sort();
      existing.bodyParams = [...new Set([...existing.bodyParams, ...u.bodyParams])].sort();
      continue;
    }
    const score = (net ? 100 : 0) + (u.kind === 'api' ? 40 : u.kind === 'page' ? 10 : 0) + (u.type !== 'string' ? 20 : 0) + (u.url.includes(EXPR) ? -5 : 0) + Math.min(10, u.queryParams.length + u.bodyParams.length);
    merged.set(key, { url: u.url, method: u.method, type: u.type, kind: u.kind, queryParams: u.queryParams, bodyParams: u.bodyParams, evidence: net ? 'network+static' : 'static', network: net, sources: [{ script: u.filename ?? '?', line: u.line, snippet: u.source }], score });
  }
  for (const [key, net] of netByKey) {
    if (merged.has(key)) continue;
    const [method, ...rest] = key.split(' ');
    const ct = net.contentType ?? '';
    if (!/json|javascript|xml|x-component|text\/plain|graphql/.test(ct) && net.status === undefined) continue;
    merged.set(key, { url: rest.join(' '), method, type: 'network', kind: /json|graphql|x-component/.test(ct) ? 'api' : 'unknown', queryParams: [], bodyParams: [], evidence: 'network', network: net, sources: [], score: 90 });
  }
  const endpoints = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 300);
  const seenSecrets = new Set<string>();
  const uniqueSecrets = secrets.filter((s) => { const k = `${s.kind}|${s.preview}|${s.filename}`; if (seenSecrets.has(k)) return false; seenSecrets.add(k); return true; });
  return { pageUrl, scripts, endpoints, secrets: uniqueSecrets, networkEntries };
}
