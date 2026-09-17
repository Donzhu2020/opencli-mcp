// Bundle the extension with esbuild: background service worker + content script; copy static assets.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const ext = resolve(root, 'extension');
const out = resolve(ext, 'dist');
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [resolve(ext, 'src/background.ts')],
  bundle: true, format: 'esm', target: 'chrome120', platform: 'browser',
  outfile: resolve(out, 'background.js'), sourcemap: false, logLevel: 'warning',
});
await build({
  entryPoints: [resolve(ext, 'src/content/cursor.ts')],
  bundle: true, format: 'iife', target: 'chrome120', platform: 'browser',
  outfile: resolve(out, 'content/cursor.js'), sourcemap: false, logLevel: 'warning',
});
const manifest = JSON.parse(readFileSync(resolve(ext, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
cpSync(resolve(ext, 'icons'), resolve(out, 'icons'), { recursive: true });
cpSync(resolve(ext, 'cursor.svg'), resolve(out, 'cursor.svg'));
console.log('extension built →', out);
