/**
 * SiteRegistry — the L1 "sites as capabilities" layer.
 * Loads OpenCLI's built-in adapter manifest (160+ sites / ~1200 commands after excluding Electron apps) plus user adapters and
 * agent-defined tools as lazy stubs in OpenCLI's global registry; modules import on first use.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { registerCommand, getRegistry, fullName, type CliCommand } from '@jackwener/opencli/registry';
import { opencliClisDir, opencliManifestPath, importDist } from '../lib/opencli.js';

export interface ManifestEntry {
  site: string; name: string; aliases?: string[]; description: string; access: 'read' | 'write';
  example?: string; domain?: string; strategy: string; browser: boolean;
  args: Array<{ name: string; type?: string; default?: unknown; required?: boolean; positional?: boolean; help?: string; choices?: string[] }>;
  columns?: string[]; pipeline?: Record<string, unknown>[]; defaultFormat?: string; modulePath?: string; sourceFile?: string;
  navigateBefore?: boolean | string; siteSession?: 'ephemeral' | 'persistent'; defaultWindowMode?: 'foreground' | 'background';
}

export interface SiteSummary {
  site: string; commands: number; read: number; write: number; strategies: string[]; domains: string[]; source: string;
  sample: string[];
}

export type SourceKind = 'builtin' | 'user' | 'defined';

type LazyCommand = CliCommand & { _lazy?: boolean; _modulePath?: string };

export const USER_OPENCLI_CLIS = path.join(os.homedir(), '.opencli', 'clis');
export const DEFINED_TOOLS_DIR = path.join(os.homedir(), '.opencli-mcp', 'tools');

export class SiteRegistry {
  private readonly loading = new Map<string, Promise<void>>();
  private readonly sourceOf = new Map<string, SourceKind>();
  loadedAt: number | null = null;

  /** Sites that only ever ran through a direct CDP connection to an Electron desktop app — this runtime drives Chrome, so they are never registered. */
  private excludedSites = new Set<string>();

  async load(): Promise<void> {
    try {
      const mod = await importDist('electron-apps.js') as { getAllElectronApps?: () => Record<string, unknown>; builtinApps?: Record<string, unknown> };
      const apps = mod.getAllElectronApps?.() ?? mod.builtinApps ?? {};
      this.excludedSites = new Set(Object.keys(apps));
    } catch { this.excludedSites = new Set(); }
    this.registerManifest(opencliManifestPath, opencliClisDir, 'builtin');
    const userManifest = path.join(USER_OPENCLI_CLIS, 'adapter-manifest.json');
    if (fs.existsSync(userManifest)) this.registerManifest(userManifest, USER_OPENCLI_CLIS, 'user');
    await this.loadDefinedTools();
    this.loadedAt = Date.now();
  }

  private registerManifest(manifestPath: string, dir: string, kind: SourceKind): void {
    if (!fs.existsSync(manifestPath)) return;
    const entries = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ManifestEntry[];
    for (const e of entries) {
      if (this.excludedSites.has(e.site)) continue;
      const modulePath = e.modulePath ? path.join(dir, e.modulePath) : undefined;
      const raw = {
        ...e,
        source: kind,
        _lazy: Boolean(modulePath),
        _modulePath: modulePath,
      } as unknown as Parameters<typeof registerCommand>[0];
      registerCommand(raw);
      this.sourceOf.set(`${e.site}/${e.name}`, kind);
    }
  }

  /** Agent-defined tools live as plain ESM adapter modules; import them eagerly (few). */
  async loadDefinedTools(): Promise<void> {
    if (!fs.existsSync(DEFINED_TOOLS_DIR)) return;
    for (const site of fs.readdirSync(DEFINED_TOOLS_DIR)) {
      const siteDir = path.join(DEFINED_TOOLS_DIR, site);
      if (!fs.statSync(siteDir).isDirectory()) continue;
      for (const file of fs.readdirSync(siteDir)) {
        if (!file.endsWith('.js')) continue;
        const full = path.join(siteDir, file);
        try {
          await import(`${pathToFileURL(full).href}?t=${fs.statSync(full).mtimeMs}`);
          for (const [key, cmd] of getRegistry()) if (key.startsWith(`${site}/`)) { this.sourceOf.set(key, 'defined'); (cmd as { source?: string }).source = 'defined'; }
        } catch (err) {
          process.stderr.write(`[opencli-mcp] failed to load defined tool ${full}: ${(err as Error).message}\n`);
        }
      }
    }
  }

  all(): CliCommand[] { return [...getRegistry().values()]; }

  sites(): SiteSummary[] {
    const by = new Map<string, CliCommand[]>();
    for (const c of this.all()) { const arr = by.get(c.site) ?? []; arr.push(c); by.set(c.site, arr); }
    return [...by.entries()].map(([site, cmds]) => ({
      site,
      commands: cmds.length,
      read: cmds.filter((c) => c.access === 'read').length,
      write: cmds.filter((c) => c.access === 'write').length,
      strategies: [...new Set(cmds.map((c) => String(c.strategy ?? 'public')))].sort(),
      domains: [...new Set(cmds.map((c) => c.domain).filter(Boolean) as string[])].sort(),
      source: this.sourceOf.get(`${site}/${cmds[0].name}`) ?? 'builtin',
      sample: cmds.slice(0, 6).map((c) => c.name),
    })).sort((a, b) => a.site.localeCompare(b.site));
  }

  commands(site: string): CliCommand[] {
    return this.all().filter((c) => c.site === site).sort((a, b) => a.name.localeCompare(b.name));
  }

  has(site: string): boolean { return this.all().some((c) => c.site === site); }

  /** Rank sites and commands for a free-text query. */
  search(query: string, limit = 20): Array<{ site: string; name?: string; description: string; score: number; strategy: string; access: string; domain?: string }> {
    const terms = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (terms.length === 0) return [];
    const hits: Array<{ site: string; name?: string; description: string; score: number; strategy: string; access: string; domain?: string }> = [];
    for (const c of this.all()) {
      const hay = { site: c.site.toLowerCase(), name: c.name.toLowerCase(), desc: c.description.toLowerCase(), domain: (c.domain ?? '').toLowerCase(), aliases: (c.aliases ?? []).join(' ').toLowerCase() };
      let score = 0;
      for (const t of terms) {
        if (hay.site === t) score += 10; else if (hay.site.includes(t)) score += 5;
        if (hay.name === t) score += 6; else if (hay.name.includes(t)) score += 3;
        if (hay.domain.includes(t)) score += 4;
        if (hay.aliases.includes(t)) score += 3;
        if (hay.desc.includes(t)) score += 2;
      }
      if (score > 0) hits.push({ site: c.site, name: c.name, description: c.description, score, strategy: String(c.strategy ?? 'public'), access: c.access, domain: c.domain });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Return a command with its implementation loaded. */
  async resolve(site: string, name: string): Promise<CliCommand> {
    const key = `${site}/${name}`;
    let cmd = getRegistry().get(key) as LazyCommand | undefined;
    if (!cmd) {
      const alias = this.all().find((c) => c.site === site && c.aliases?.includes(name));
      if (!alias) throw Object.assign(new Error(`Unknown command ${key}`), { code: 'unknown_command' });
      cmd = alias as LazyCommand;
    }
    if (cmd._lazy && cmd._modulePath) {
      const mp = cmd._modulePath;
      let p = this.loading.get(mp);
      if (!p) {
        p = import(pathToFileURL(mp).href).then(() => undefined);
        this.loading.set(mp, p);
      }
      await p;
      const loaded = getRegistry().get(fullName(cmd)) as LazyCommand | undefined;
      if (loaded && !loaded._lazy) cmd = loaded;
      else if (!loaded?.func && !loaded?.pipeline) throw Object.assign(new Error(`Adapter module ${mp} did not register ${key}`), { code: 'adapter_load' });
      else cmd = loaded;
    }
    return cmd;
  }
}
