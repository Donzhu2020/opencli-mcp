/**
 * Installer: Native Messaging host manifests for Chromium browsers and the launcher script Chrome executes.
 * The extension ID is fixed by the project: the public key in extension/manifest.json determines it, on every machine
 * and later on the Chrome Web Store alike — so a zip of extension/dist loaded anywhere connects.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NATIVE_HOST_NAME } from '../protocol.js';
import { OPENCLI_MCP_DIR } from './state.js';

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

/** The extension ID Chrome derives from the `key` in the manifest (the same everywhere). */
export function extensionId(): string {
  const m = JSON.parse(fs.readFileSync(path.join(extensionDir(), 'manifest.json'), 'utf8')) as { key?: string };
  if (!m.key) throw new Error('extension manifest has no key — the build is incomplete');
  return extensionIdFromKey(m.key);
}
function extensionIdFromKey(keyBase64: string): string {
  const hex = createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
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

/**
 * Profiles of Chromium browsers running right now with a custom --user-data-dir (Chrome for Testing, dev profiles,
 * test harnesses). Chrome resolves user-level Native Messaging hosts under that directory, so the manifest must be
 * written there too — the single most common reason a first install "did nothing".
 */
export function runningProfileDirs(): string[] {
  if (process.platform === 'win32') return [];
  try {
    const out = execFileSync('ps', ['ax', '-o', 'command'], { encoding: 'utf8', stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 });
    const dirs = new Set<string>();
    for (const line of out.split('\n')) {
      if (!/chrome|chromium|edge|brave/i.test(line)) continue;
      const m = /--user-data-dir=("([^"]+)"|(\S+))/.exec(line);
      const d = m?.[2] ?? m?.[3];
      if (d && fs.existsSync(d)) dirs.add(d);
    }
    return [...dirs];
  } catch { return []; }
}

export function writeLauncher(): string {
  const bin = path.join(OPENCLI_MCP_DIR, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const main = path.join(projectRoot(), 'dist', 'src', 'main.js');
  if (!fs.existsSync(main)) throw new Error('dist/src/main.js not found — run `npm run build` before `opencli-mcp install`');
  const entry = main;
  if (process.platform === 'win32') {
    const file = path.join(bin, 'opencli-mcp-host.cmd');
    fs.writeFileSync(file, `@echo off\r\n"${process.execPath}" "${entry}" host --native\r\n`);
    return file;
  }
  const file = path.join(bin, 'opencli-mcp-host');
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${entry}" host --native\n`, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

export function install(opts: { browsers?: string[]; extensionId?: string; userDataDirs?: string[] } = {}): { extensionId: string; extensionDir: string; launcher: string; manifests: Array<{ browser: string; file: string; written: boolean }> } {
  const extDir = extensionDir();
  const id = opts.extensionId ?? extensionId();
  const launcher = writeLauncher();
  const manifest = { name: NATIVE_HOST_NAME, description: 'opencli-mcp browser runtime host', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] };
  const manifests: Array<{ browser: string; file: string; written: boolean }> = [];
  // Chrome resolves user-level hosts relative to its user data dir: custom --user-data-dir profiles get their own copy
  const profiles = new Set([...(opts.userDataDirs ?? []), ...runningProfileDirs()]);
  const targets = [...nativeHostDirs(), ...[...profiles].map((d) => ({ browser: `profile:${d}`, dir: path.join(d, 'NativeMessagingHosts') }))];
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
  return { extensionId: id, extensionDir: extDir, launcher, manifests };
}

export function uninstall(): string[] {
  const removed: string[] = [];
  for (const { dir } of [...nativeHostDirs(), ...runningProfileDirs().map((d) => ({ dir: path.join(d, 'NativeMessagingHosts') }))]) {
    const file = path.join(dir, `${NATIVE_HOST_NAME}.json`);
    if (fs.existsSync(file)) { fs.rmSync(file); removed.push(file); }
  }
  return removed;
}
