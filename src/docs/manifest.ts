/**
 * Docs-as-interface. A documents manifest (Codex documents.json style) decides which markdown
 * is delivered as server `instructions` and which is attached to tool results on demand.
 * Docs are static files bundled with the server, so disk reads are memoized.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DocMode = 'included' | 'model' | 'lookup';
export interface DocEntry {
  name: string;
  mode: DocMode;
  description?: string;
  when?: { backends?: Array<'extension' | 'none'>; capabilities?: string[] };
}
export interface DocContext { backend: 'extension' | 'none'; capabilities: string[] }

export const DOCS_MANIFEST: DocEntry[] = [
  { name: 'instructions', mode: 'included' },
  { name: 'api-use', mode: 'included' },
  { name: 'safety', mode: 'included' },
  { name: 'tab-lifecycle', mode: 'included', when: { backends: ['extension'] } },
  { name: 'sites', mode: 'lookup', description: 'the site-command corpus: search, enable as tools, and freeze flows into tools' },
  { name: 'js-tool', mode: 'model' },
  { name: 'api-reference', mode: 'model', description: 'the whole object model, generated from its TypeScript declarations' },
  { name: 'errors', mode: 'lookup', description: 'error code families and what to do for each' },
  { name: 'recon', mode: 'lookup', description: 'read before discovering a site’s API endpoints' },
  { name: 'define-tools', mode: 'lookup', description: 'read before freezing a flow into a tool' },
  { name: 'capabilities/cdp', mode: 'model', when: { capabilities: ['cdp'] } },
  { name: 'capabilities/webmcp', mode: 'model', when: { capabilities: ['webmcp'] } },
  { name: 'capabilities/visibility', mode: 'model', when: { capabilities: ['visibility'] } },
  { name: 'troubleshooting', mode: 'lookup', description: 'read when the browser bridge fails' },
];

let docsDirCache: string | undefined;
function docsDir(): string {
  if (docsDirCache) return docsDirCache;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const c of [path.resolve(here, '../../docs'), path.resolve(here, '../../../docs'), path.resolve(here, '../docs')]) {
    if (fs.existsSync(path.join(c, 'instructions.md'))) { docsDirCache = c; return c; }
  }
  docsDirCache = path.resolve(here, '../../docs');
  return docsDirCache;
}

const docCache = new Map<string, string | null>();
export function readDoc(name: string): string | null {
  const hit = docCache.get(name);
  if (hit !== undefined) return hit;
  const file = path.join(docsDir(), `${name}.md`);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  docCache.set(name, text);
  return text;
}

export function listDocs(ctx: DocContext): Array<DocEntry & { available: boolean }> {
  return DOCS_MANIFEST.map((d) => ({ ...d, available: applies(d, ctx) }));
}

export function applies(d: DocEntry, ctx: DocContext): boolean {
  if (d.when?.backends && !d.when.backends.includes(ctx.backend)) return false;
  if (d.when?.capabilities && !d.when.capabilities.every((c) => ctx.capabilities.includes(c))) return false;
  return true;
}

const instructionsCache = new Map<string, string>();
/** Concatenate all `included` docs that apply → MCP server instructions (memoized per context). */
export function buildInstructions(ctx: DocContext): string {
  const key = `${ctx.backend}|${[...ctx.capabilities].sort().join(',')}`;
  const cached = instructionsCache.get(key);
  if (cached !== undefined) return cached;
  const parts: string[] = [];
  for (const d of DOCS_MANIFEST) {
    if (d.mode !== 'included' || !applies(d, ctx)) continue;
    const text = readDoc(d.name);
    if (text) parts.push(text.trim());
  }
  const lookups = DOCS_MANIFEST.filter((d) => d.mode === 'lookup' && applies(d, ctx)).map((d) => `- \`${d.name}\`: ${d.description ?? ''}`);
  if (lookups.length) parts.push(`## Lookup docs (call docs_get)\n${lookups.join('\n')}`);
  const out = parts.join('\n\n');
  instructionsCache.set(key, out);
  return out;
}
