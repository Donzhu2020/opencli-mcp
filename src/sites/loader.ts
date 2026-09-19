/**
 * SourceLoader — the adapter layer. An adapter is a self-describing module at `<source>/<site>/<command>.js` that
 * `export default defineAdapter({ description, access, args, run })`. Identity is the PATH; the module is the definition.
 * There is no manifest and no global registry: the loader lists by `readdir`, resolves by importing the file, and keeps
 * a small in-memory index (rebuilt on directory mtime change) for cross-site search.
 *
 * Sources are an ordered list; a later source overrides an earlier one for the same `<site>/<command>` — so the
 * built-in corpus, the user's `~/.opencli-mcp/adapters`, and agent-defined tools are one mechanism, not three.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Arg } from './schema.js';

export type SourceKind = 'builtin' | 'user';

export interface Source { dir: string; kind: SourceKind }

export interface AdapterContext {
  args: Record<string, unknown>;
  tab: unknown;
  sites: unknown;
  recon: unknown;
  signal?: AbortSignal;
}

/** A loaded adapter: the descriptor from the module plus its path-derived identity. */
export interface AdapterCommand {
  site: string;
  name: string;
  description: string;
  access: 'read' | 'write';
  browser: boolean;
  domain?: string;
  args: Arg[];
  aliases?: string[];
  source: SourceKind;
  run: (ctx: AdapterContext) => Promise<unknown>;
}

const isCommandFile = (f: string): boolean => f.endsWith('.js') && !f.startsWith('_');
const cmdName = (f: string): string => f.replace(/\.js$/, '');

export class SiteRegistry {
  loadedAt: number | null = null;
  private index: Array<Omit<AdapterCommand, 'run'>> | null = null;
  private indexStamp = '';

  constructor(private sources: Source[] = []) {}

  /** Replace the source list (later overrides earlier). */
  setSources(sources: Source[]): void { this.sources = sources; this.index = null; }
  addSource(source: Source): void { this.sources.push(source); this.index = null; }

  async load(): Promise<void> { this.index = null; await this.buildIndex(); this.loadedAt = Date.now(); }

  private existingDirs(): Source[] { return this.sources.filter((s) => { try { return fs.statSync(s.dir).isDirectory(); } catch { return false; } }); }

  /** A cheap fingerprint of every source/site dir mtime, so the index rebuilds only when files actually change. */
  private stamp(): string {
    const parts: string[] = [];
    for (const s of this.existingDirs()) {
      try { parts.push(`${s.dir}:${fs.statSync(s.dir).mtimeMs}`); } catch { /* ignore */ }
      for (const site of this.siteDirs(s.dir)) { try { parts.push(`${site}:${fs.statSync(path.join(s.dir, site)).mtimeMs}`); } catch { /* ignore */ } }
    }
    return parts.join('|');
  }

  private siteDirs(dir: string): string[] {
    try { return fs.readdirSync(dir).filter((d) => { try { return fs.statSync(path.join(dir, d)).isDirectory() && !d.startsWith('.'); } catch { return false; } }); }
    catch { return []; }
  }

  /** site -> command-name -> absolute file path (later source wins). */
  private map(): Map<string, Map<string, string>> {
    const out = new Map<string, Map<string, string>>();
    for (const s of this.existingDirs()) {
      for (const site of this.siteDirs(s.dir)) {
        const siteDir = path.join(s.dir, site);
        let files: string[]; try { files = fs.readdirSync(siteDir); } catch { continue; }
        const bucket = out.get(site) ?? new Map<string, string>();
        for (const f of files) if (isCommandFile(f)) bucket.set(cmdName(f), path.join(siteDir, f));
        out.set(site, bucket);
      }
    }
    return out;
  }

  private kindOf(file: string): SourceKind {
    for (let i = this.sources.length - 1; i >= 0; i--) if (file.startsWith(this.sources[i].dir + path.sep)) return this.sources[i].kind;
    return 'builtin';
  }

  private async importDescriptor(file: string): Promise<Record<string, unknown>> {
    const mod = await import(`${pathToFileURL(file).href}?t=${fs.statSync(file).mtimeMs}`) as { default?: Record<string, unknown> };
    if (!mod.default || typeof mod.default.run !== 'function') throw Object.assign(new Error(`${file} must \`export default defineAdapter({...})\``), { code: 'adapter_load' });
    return mod.default;
  }

  private toCommand(site: string, name: string, file: string, d: Record<string, unknown>): AdapterCommand {
    return {
      site, name, source: this.kindOf(file),
      description: String(d.description ?? ''),
      access: d.access === 'write' ? 'write' : 'read',
      browser: d.browser !== false,
      domain: d.domain as string | undefined,
      args: (d.args as Arg[]) ?? [],
      aliases: d.aliases as string[] | undefined,
      run: d.run as (ctx: AdapterContext) => Promise<unknown>,
    };
  }

  private async buildIndex(): Promise<Array<Omit<AdapterCommand, 'run'>>> {
    const stamp = this.stamp();
    if (this.index && this.indexStamp === stamp) return this.index;
    const map = this.map();
    const out: Array<Omit<AdapterCommand, 'run'>> = [];
    for (const [site, cmds] of map) {
      for (const [name, file] of cmds) {
        try { const { run: _run, ...meta } = this.toCommand(site, name, file, await this.importDescriptor(file)); out.push(meta); }
        catch (err) { process.stderr.write(`[opencli-mcp] failed to load adapter ${file}: ${(err as Error).message}\n`); }
      }
    }
    this.index = out; this.indexStamp = stamp;
    return out;
  }

  private async all(): Promise<Array<Omit<AdapterCommand, 'run'>>> { return this.buildIndex(); }

  has(site: string): boolean { return this.map().has(site); }

  sites(): Array<{ site: string; commands: number; read: number; write: number; domains: string[]; source: SourceKind; sample: string[] }> {
    const idx = this.index ?? [];
    const map = this.map();
    return [...map.entries()].map(([site, cmds]) => {
      const metas = idx.filter((c) => c.site === site);
      return {
        site, commands: cmds.size,
        read: metas.filter((c) => c.access === 'read').length,
        write: metas.filter((c) => c.access === 'write').length,
        domains: [...new Set(metas.map((c) => c.domain).filter(Boolean) as string[])],
        source: metas[0]?.source ?? 'builtin',
        sample: [...cmds.keys()].slice(0, 6),
      };
    }).sort((a, b) => a.site.localeCompare(b.site));
  }

  commandNames(site: string): string[] { return [...(this.map().get(site)?.keys() ?? [])].sort(); }

  /** Command metadata for a site (from the index; loads it if cold). */
  async commands(site: string): Promise<Array<Omit<AdapterCommand, 'run'>>> { return (await this.all()).filter((c) => c.site === site).sort((a, b) => a.name.localeCompare(b.name)); }

  /** Rank commands for a free-text query, using the in-memory index. */
  async search(query: string, limit = 20): Promise<Array<{ site: string; name: string; description: string; score: number; access: string; domain?: string; args: string[] }>> {
    const terms = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (!terms.length) return [];
    const hits: Array<{ site: string; name: string; description: string; score: number; access: string; domain?: string; args: string[] }> = [];
    for (const c of await this.all()) {
      const hay = { site: c.site.toLowerCase(), name: c.name.toLowerCase(), desc: c.description.toLowerCase(), domain: (c.domain ?? '').toLowerCase(), aliases: (c.aliases ?? []).join(' ').toLowerCase() };
      let score = 0;
      for (const t of terms) {
        if (hay.site === t) score += 10; else if (hay.site.includes(t)) score += 5;
        if (hay.name === t) score += 6; else if (hay.name.includes(t)) score += 3;
        if (hay.domain.includes(t)) score += 4;
        if (hay.aliases.includes(t)) score += 3;
        if (hay.desc.includes(t)) score += 2;
      }
      if (score > 0) hits.push({ site: c.site, name: c.name, description: c.description, score, access: c.access, domain: c.domain, args: c.args.map((a) => `${a.name}${a.required ? '*' : ''}${a.type ? `:${a.type}` : ''}`) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Load a command with its `run` implementation. Resolves aliases via the index. */
  async resolve(site: string, name: string): Promise<AdapterCommand> {
    const bucket = this.map().get(site);
    let file = bucket?.get(name);
    if (!file) {
      const alias = (await this.all()).find((c) => c.site === site && c.aliases?.includes(name));
      if (alias) file = bucket?.get(alias.name);
    }
    if (!file) throw Object.assign(new Error(`Unknown command ${site}/${name}`), { code: 'unknown_command' });
    return this.toCommand(site, name, file, await this.importDescriptor(file));
  }
}
