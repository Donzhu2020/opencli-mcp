/** Diagnose the bridge: manifests, extension build, host state, health, Chrome presence. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NATIVE_HOST_NAME } from '../protocol.js';
import { extensionDir, nativeHostDirs, KEY_FILE } from './install.js';
import { hostHealth, readHostState, HOST_STATE_FILE } from './state.js';

export interface DoctorResult {
  ok: boolean;
  node: string;
  extension: { dir: string; built: boolean; id: string | null };
  manifests: Array<{ browser: string; file: string; present: boolean; launcherExists: boolean }>;
  host: { stateFile: string; running: boolean; port?: number; backend?: string; extensionConnected?: boolean; error?: string };
  chromeRunning: boolean | null;
  advice: string[];
}

export async function doctor(): Promise<DoctorResult> {
  const extDir = extensionDir();
  let id: string | null = null;
  try { id = (JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')) as { id: string }).id; } catch { /* not installed */ }
  const built = fs.existsSync(path.join(extDir, 'background.js')) && fs.existsSync(path.join(extDir, 'manifest.json'));
  const manifests = nativeHostDirs().map(({ browser, dir }) => {
    const file = path.join(dir, `${NATIVE_HOST_NAME}.json`);
    let launcherExists = false;
    try { const m = JSON.parse(fs.readFileSync(file, 'utf8')) as { path: string }; launcherExists = fs.existsSync(m.path); } catch { /* absent */ }
    return { browser, file, present: fs.existsSync(file), launcherExists };
  });
  const state = readHostState();
  const health = await hostHealth(state);
  let chromeRunning: boolean | null = null;
  if (process.platform !== 'win32') {
    try { const out = execFileSync('pgrep', ['-fl', 'Google Chrome|Chromium|Microsoft Edge|Brave Browser'], { encoding: 'utf8', stdio: 'pipe' }); chromeRunning = out.trim().length > 0; } catch { chromeRunning = false; }
  }
  const advice: string[] = [];
  if (!built) advice.push('Build the extension: npm run build (or npm run build:ext).');
  if (!manifests.some((m) => m.present)) advice.push('Run `opencli-mcp install` to write the Native Messaging host manifest.');
  if (!id) advice.push('No extension key yet: `opencli-mcp install` generates a stable extension ID.');
  if (!health.ok) advice.push(`Host not reachable (${health.error ?? 'unknown'}): open chrome://extensions, enable Developer mode, Load unpacked → ${extDir}. The extension spawns the host automatically; reload the extension after (re)installing.`);
  else if (!health.extensionConnected) advice.push('Host is up but the extension has not said hello: reload the extension in chrome://extensions.');
  if (chromeRunning === false) advice.push('No Chromium-based browser process found; start Chrome.');
  return {
    ok: built && manifests.some((m) => m.present) && health.ok && Boolean(health.extensionConnected),
    node: process.version,
    extension: { dir: extDir, built, id },
    manifests,
    host: { stateFile: HOST_STATE_FILE, running: health.ok, port: state?.port, backend: health.backend, extensionConnected: health.extensionConnected, error: health.error },
    chromeRunning,
    advice,
  };
}
