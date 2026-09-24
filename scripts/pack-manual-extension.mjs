// Package the key-bearing extension build for Chrome's Load unpacked flow.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXTENSION_ID } from '../dist/src/host/extension.js';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'extension/dist');
const manifestFile = resolve(dist, 'manifest.json');
if (!existsSync(manifestFile)) throw new Error('extension/dist not built — run `npm run build` first');

const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
if (typeof manifest.key !== 'string' || !manifest.key) throw new Error('Manual extension build must include manifest.key');
const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
const id = digest.replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
if (id !== EXTENSION_ID) throw new Error(`Extension ID ${id} does not match native host ID ${EXTENSION_ID}`);

const out = resolve(root, `opencli-mcp-extension-manual-install-${manifest.version}.zip`);
rmSync(out, { force: true });
execFileSync('zip', ['-qr', out, '.'], { cwd: dist });
console.log(`Manual extension zip → ${out} (ID ${id}; extract, then Load unpacked in Chrome)`);
