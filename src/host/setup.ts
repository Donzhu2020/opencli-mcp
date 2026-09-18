/**
 * `opencli-mcp setup` — the whole first-run in one command, for a human at a terminal:
 *   1. install: Native Messaging host manifest(s) + the stable extension key
 *   2. print the one MCP configuration every client accepts (stdio command, or the HTTP endpoint for remote agents)
 *   3. open chrome://extensions and put the unpacked-extension path on the clipboard
 *   4. wait for the extension to connect (it spawns the host) and report green
 * Everything it does is what `install` / `doctor` do; it only strings them together and talks in sentences instead of
 * JSON. The runtime knows no client: MCP is the contract, so the user gets the standard snippet and pastes it wherever
 * their client keeps it. Chrome cannot load an unpacked extension for us: that one click stays with the user until the
 * extension is on the Chrome Web Store.
 */
import { execFileSync, spawn } from 'node:child_process';
import { install, projectRoot } from './install.js';
import { doctor } from './doctor.js';
import { TOKEN_FILE, DEFAULT_PORT, readConfig } from './state.js';
import path from 'node:path';
import fs from 'node:fs';

const say = (line: string): void => { process.stdout.write(`${line}\n`); };

function which(cmd: string): string | null {
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim() || null; } catch { return null; }
}

/** The stdio command a client should run: the package binary when installed globally, else node + this build. */
function stdioCommand(main: string): { command: string; args: string[] } {
  const bin = which('opencli-mcp');
  return bin ? { command: 'opencli-mcp', args: [] } : { command: 'node', args: [main] };
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

  const c = stdioCommand(main);
  const port = readConfig().port ?? DEFAULT_PORT;
  say('2/4  Add opencli-mcp to your MCP client (any client; the runtime does not care which):');
  say(`       stdio  → ${JSON.stringify({ mcpServers: { 'opencli-mcp': { command: c.command, args: c.args } } })}`);
  say(`       http   → http://127.0.0.1:${port}/mcp  with header  Authorization: Bearer <contents of ${TOKEN_FILE}>  (remote agents: put it behind an authenticated tunnel)`);

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
