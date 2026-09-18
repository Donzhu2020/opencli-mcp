/**
 * `opencli-mcp setup` — the whole first-run in one command, for a human at a terminal:
 *   1. install: Native Messaging host manifest(s) + the stable extension key
 *   2. register the stdio server with MCP clients found on this machine (Claude Code today)
 *   3. open chrome://extensions and put the unpacked-extension path on the clipboard
 *   4. wait for the extension to connect (it spawns the host) and report green
 * Everything it does is what `install` / `claude mcp add` / `doctor` do; it only strings them together and talks in
 * sentences instead of JSON. Chrome cannot load an unpacked extension for us: that one click stays with the user until
 * the extension is on the Chrome Web Store.
 */
import { execFileSync, spawn } from 'node:child_process';
import { install, projectRoot } from './install.js';
import { doctor } from './doctor.js';
import path from 'node:path';
import fs from 'node:fs';

const say = (line: string): void => { process.stdout.write(`${line}\n`); };

function which(cmd: string): string | null {
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim() || null; } catch { return null; }
}

/** Register the stdio server with Claude Code (user scope) when the CLI is installed and no entry exists yet. */
function registerClaudeCode(main: string): 'added' | 'present' | 'absent' | 'failed' {
  if (!which('claude')) return 'absent';
  try { execFileSync('claude', ['mcp', 'get', 'opencli-mcp'], { stdio: 'ignore' }); return 'present'; } catch { /* not registered */ }
  try { execFileSync('claude', ['mcp', 'add', '-s', 'user', 'opencli-mcp', '--', process.execPath, main], { stdio: 'ignore' }); return 'added'; } catch { return 'failed'; }
}

function copyToClipboard(text: string): boolean {
  const cmd = process.platform === 'darwin' ? ['pbcopy'] : process.platform === 'win32' ? ['clip'] : which('xclip') ? ['xclip', '-selection', 'clipboard'] : which('wl-copy') ? ['wl-copy'] : null;
  if (!cmd) return false;
  try { execFileSync(cmd[0], cmd.slice(1), { input: text, stdio: ['pipe', 'ignore', 'ignore'] }); return true; } catch { return false; }
}

function openExtensionsPage(): boolean {
  const url = 'chrome://extensions';
  try {
    if (process.platform === 'darwin') spawn('open', ['-a', 'Google Chrome', url], { stdio: 'ignore', detached: true }).unref();
    else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', 'chrome', url], { stdio: 'ignore', detached: true }).unref();
    else spawn(which('google-chrome') ?? which('chromium') ?? 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    return true;
  } catch { return false; }
}

export async function setup(opts: { waitMs?: number; noOpen?: boolean } = {}): Promise<boolean> {
  const main = path.join(projectRoot(), 'dist', 'src', 'main.js');
  if (!fs.existsSync(main)) { say('dist/src/main.js not found — run `npm run build` first.'); return false; }

  const r = install();
  const written = r.manifests.filter((m) => m.written).map((m) => m.browser);
  say(`1/4  Host manifest written for: ${written.join(', ') || 'no browser profile found (start Chrome once, or pass --user-data-dir to install)'}. Extension ID ${r.extensionId}.`);

  const cc = registerClaudeCode(main);
  say(`2/4  Claude Code: ${{ added: 'registered (user scope) — restart claude to see the tools', present: 'already registered', absent: 'not installed here — for other clients add { "command": "node", "args": ["' + main + '"] }', failed: 'registration failed — run: claude mcp add -s user opencli-mcp -- node ' + main }[cc]}`);

  const copied = copyToClipboard(r.extensionDir);
  const opened = opts.noOpen ? false : openExtensionsPage();
  say(`3/4  ${opened ? 'Opened chrome://extensions.' : 'Open chrome://extensions.'} Turn on Developer mode → Load unpacked → ${copied ? 'paste the path (it is on your clipboard)' : 'choose'}: ${r.extensionDir}`);

  const until = Date.now() + (opts.waitMs ?? 180_000);
  say('4/4  Waiting for the extension to connect…');
  let last = '';
  while (Date.now() < until) {
    const d = await doctor();
    if (d.ok) { say(`     Connected: host on port ${d.host.port}, extension ${d.extension.id}. Done — opencli-mcp is ready.`); return true; }
    const now = d.host.running ? 'host is up, extension not connected yet (reload it in chrome://extensions if it was already loaded)' : 'extension not loaded yet';
    if (now !== last) { say(`     ${now}`); last = now; }
    await new Promise((res) => setTimeout(res, 2000));
  }
  say('     Still not connected. Run `opencli-mcp doctor` for details once the extension is loaded.');
  return false;
}
