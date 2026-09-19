// Build the Chrome Web Store upload zip from extension/dist, with the `key` field stripped from the manifest
// (the Web Store assigns the extension ID; a self-managed `key` is only for stable IDs on locally-loaded builds).
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'extension/dist');
if (!existsSync(resolve(dist, 'manifest.json'))) { console.error('extension/dist not built — run `npm run build` first'); process.exit(1); }

const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
const version = manifest.version;
delete manifest.key; // Web Store manages the extension ID

const staging = resolve(root, `.store-extension-${version}`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync(dist, staging, { recursive: true });
writeFileSync(resolve(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));

const out = resolve(root, `opencli-mcp-extension-store-${version}.zip`);
rmSync(out, { force: true });
execFileSync('zip', ['-qr', out, '.'], { cwd: staging });
rmSync(staging, { recursive: true, force: true });
console.log(`store extension zip → ${out} (manifest v${version}, key removed)`);
