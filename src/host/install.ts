/**
 * Installer: stable extension key/ID, Native Messaging host manifests for Chromium browsers,
 * and the launcher script Chrome executes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NATIVE_HOST_NAME } from '../protocol.js';
import { OPENCLI_MCP_DIR } from './state.js';

export const KEY_FILE = path.join(OPENCLI_MCP_DIR, 'extension-key.json');

export function projectRoot(): string {
  // walk up from this file to the nearest package.json that is ours (works from src/ under tsx and from dist/src/)
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, 'package.json');
    try { if ((JSON.parse(fs.readFileSync(pkg, 'utf8')) as { name?: string }).name === 'opencli-mcp') return dir; } catch { /* keep walking */ }
    dir = path.dirname(dir);
  }
  throw new Error('opencli-mcp project root not found');
}
export function extensionDir(): string {
  const root = projectRoot();
  const dist = path.join(root, 'extension', 'dist');
  return fs.existsSync(path.join(dist, 'manifest.json')) ? dist : path.join(root, 'extension');
}

/** Chrome derives an unpacked extension's ID from `key`; we generate one once so the ID is stable. */
export function ensureExtensionKey(): { key: string; id: string } {
  try {
    const j = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')) as { key: string; id: string };
    if (j.key && j.id) return j;
  } catch { /* create */ }
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'der' } });
  const key = (publicKey as Buffer).toString('base64');
  const id = extensionIdFromKey(key);
  fs.mkdirSync(OPENCLI_MCP_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, JSON.stringify({ key, id }, null, 2), { mode: 0o600 });
  return { key, id };
}
export function extensionIdFromKey(keyBase64: string): string {
  const hex = createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

export function patchExtensionManifest(key: string): string {
  const dir = extensionDir();
  const file = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (m.key !== key) { m.key = key; fs.writeFileSync(file, JSON.stringify(m, null, 2)); }
  return dir;
}

export function nativeHostDirs(): Array<{ browser: string; dir: string }> {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return [
      { browser: 'chrome', dir: path.join(base, 'Google', 'Chrome', 'NativeMessagingHosts') },
      { browser: 'chrome-beta', dir: path.join(base, 'Google', 'Chrome Beta', 'NativeMessagingHosts') },
      { browser: 'chrome-canary', dir: path.join(base, 'Google', 'Chrome Canary', 'NativeMessagingHosts') },
      { browser: 'chrome-for-testing', dir: path.join(base, 'Google', 'Chrome for Testing', 'NativeMessagingHosts') },
      { browser: 'chromium', dir: path.join(base, 'Chromium', 'NativeMessagingHosts') },
      { browser: 'edge', dir: path.join(base, 'Microsoft Edge', 'NativeMessagingHosts') },
      { browser: 'brave', dir: path.join(base, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts') },
      { browser: 'arc', dir: path.join(base, 'Arc', 'User Data', 'NativeMessagingHosts') },
    ];
  }
  if (process.platform === 'linux') {
    const base = path.join(home, '.config');
    return [
      { browser: 'chrome', dir: path.join(base, 'google-chrome', 'NativeMessagingHosts') },
      { browser: 'chromium', dir: path.join(base, 'chromium', 'NativeMessagingHosts') },
      { browser: 'edge', dir: path.join(base, 'microsoft-edge', 'NativeMessagingHosts') },
      { browser: 'brave', dir: path.join(base, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts') },
    ];
  }
  return [{ browser: 'chrome', dir: path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'opencli-mcp') }];
}

export function writeLauncher(): string {
  const bin = path.join(OPENCLI_MCP_DIR, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const main = path.join(projectRoot(), 'dist', 'src', 'main.js');
  if (!fs.existsSync(main)) throw new Error('dist/src/main.js not found — run `npm run build` before `opencli-mcp install`');
  const entry = main;
  // Chrome spawns the host with its own environment; bake the settings the launcher relies on
  const envLines = ['OPENCLI_MCP_HOME', 'OPENCLI_CDP_ENDPOINT'].filter((k) => process.env[k]).map((k) => process.platform === 'win32' ? `set ${k}=${process.env[k]}` : `export ${k}=${JSON.stringify(process.env[k])}`);
  if (process.platform === 'win32') {
    const file = path.join(bin, 'opencli-mcp-host.cmd');
    fs.writeFileSync(file, `@echo off\r\n${envLines.map((l) => l + '\r\n').join('')}"${process.execPath}" "${entry}" host --native\r\n`);
    return file;
  }
  const file = path.join(bin, 'opencli-mcp-host');
  fs.writeFileSync(file, `#!/bin/sh\n${envLines.map((l) => l + '\n').join('')}exec "${process.execPath}" "${entry}" host --native\n`, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

export function install(opts: { browsers?: string[]; extensionId?: string; userDataDirs?: string[] } = {}): { extensionId: string; extensionDir: string; launcher: string; manifests: Array<{ browser: string; file: string; written: boolean }> } {
  const { key, id } = ensureExtensionKey();
  const extDir = patchExtensionManifest(key);
  const extensionId = opts.extensionId ?? id;
  const launcher = writeLauncher();
  const manifest = { name: NATIVE_HOST_NAME, description: 'opencli-mcp browser runtime host', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] };
  const manifests: Array<{ browser: string; file: string; written: boolean }> = [];
  // Chrome resolves user-level hosts relative to its user data dir: custom --user-data-dir profiles get their own copy
  const targets = [...nativeHostDirs(), ...(opts.userDataDirs ?? []).map((d) => ({ browser: `profile:${d}`, dir: path.join(d, 'NativeMessagingHosts') }))];
  for (const { browser, dir } of targets) {
    if (opts.browsers && !opts.browsers.includes(browser)) continue;
    const parent = path.dirname(dir);
    // only write where the browser profile dir exists (or for explicitly requested browsers)
    if (!opts.browsers && !browser.startsWith('profile:') && !fs.existsSync(parent)) { manifests.push({ browser, file: path.join(dir, `${NATIVE_HOST_NAME}.json`), written: false }); continue; }
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${NATIVE_HOST_NAME}.json`);
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    manifests.push({ browser, file, written: true });
    if (process.platform === 'win32') {
      try { execFileSync('reg', ['add', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', file, '/f'], { stdio: 'ignore' }); } catch { /* best effort */ }
    }
  }
  return { extensionId, extensionDir: extDir, launcher, manifests };
}

export function uninstall(): string[] {
  const removed: string[] = [];
  for (const { dir } of nativeHostDirs()) {
    const file = path.join(dir, `${NATIVE_HOST_NAME}.json`);
    if (fs.existsSync(file)) { fs.rmSync(file); removed.push(file); }
  }
  return removed;
}
