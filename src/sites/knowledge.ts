/** Site memory: what OpenCLI adapters/recon recorded for a site under ~/.opencli/sites/<site>/ (endpoints.json, notes, field maps). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SITES_DIR = path.join(os.homedir(), '.opencli', 'sites');

export function readSiteKnowledge(site: string): { site: string; dir: string; files: Record<string, unknown> } {
  const dir = path.join(SITES_DIR, site.replace(/[^a-z0-9._-]/gi, '_'));
  const files: Record<string, unknown> = {};
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (!fs.statSync(full).isFile() || fs.statSync(full).size > 512 * 1024) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (f.endsWith('.json')) { try { files[f] = JSON.parse(text); continue; } catch { /* raw */ } }
      files[f] = text;
    }
  }
  return { site, dir, files };
}

export function writeSiteKnowledge(site: string, name: string, data: unknown): string {
  const dir = path.join(SITES_DIR, site.replace(/[^a-z0-9._-]/gi, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return file;
}
