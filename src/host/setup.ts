/** Set up both connections: Chrome → local host, MCP client → local host. */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { registerHost, projectRoot } from './registration.js';
import { doctor } from './doctor.js';
import { EXTENSION_STORE_URL } from './extension.js';
import path from 'node:path';

const say = (line: string): void => { process.stdout.write(`${line}\n`); };
const exec = promisify(execFile);
type StdioCommand = { command: string; args: string[] };
type ClientRegistration = { name: string; status: 'existing' | 'registered' | 'failed' };

function which(cmd: string): string | null {
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).split(/\r?\n/)[0].trim() || null; } catch { return null; }
}

const CLIENTS = [
  { name: 'Claude Code', bin: 'claude', scope: ['-s', 'user'] },
  { name: 'Codex', bin: 'codex', scope: [] },
];
function registerClients(c: StdioCommand): ClientRegistration[] {
  const results: ClientRegistration[] = [];
  for (const client of CLIENTS) {
    const bin = which(client.bin);
    if (!bin) continue;
    const options = { stdio: 'ignore' as const, timeout: 15_000 };
    try {
      execFileSync(bin, ['mcp', 'get', 'opencli-mcp'], options);
      results.push({ name: client.name, status: 'existing' });
      continue;
    } catch { /* No existing registration; try to add it. */ }
    try {
      execFileSync(bin, ['mcp', 'add', ...client.scope, 'opencli-mcp', '--', c.command, ...c.args], options);
      results.push({ name: client.name, status: 'registered' });
    } catch { results.push({ name: client.name, status: 'failed' }); }
  }
  return results;
}

async function openStorePage(): Promise<boolean> {
  try {
    if (process.platform === 'darwin') await exec('open', ['-a', 'Google Chrome', EXTENSION_STORE_URL], { timeout: 10_000 });
    else if (process.platform === 'win32') await exec('rundll32', ['url.dll,FileProtocolHandler', EXTENSION_STORE_URL], { timeout: 10_000 });
    else {
      // Browser processes may stay alive for the whole session; do not time out and kill them.
      return await new Promise<boolean>((resolve) => {
        const child = spawn(which('google-chrome') ?? which('chromium') ?? 'xdg-open', [EXTENSION_STORE_URL], { detached: true, stdio: 'ignore' });
        child.once('error', () => resolve(false));
        child.once('spawn', () => { child.unref(); resolve(true); });
      });
    }
    return true;
  } catch { return false; }
}

export async function setup(opts: { waitMs?: number; noOpen?: boolean; browsers?: string[]; userDataDirs?: string[] } = {}): Promise<boolean> {
  const waitMs = opts.waitMs ?? 180_000;
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('--wait must be a non-negative number of seconds.');

  const registration = registerHost({ browsers: opts.browsers, userDataDirs: opts.userDataDirs });
  const written = registration.manifests.filter((m) => m.written);
  if (!written.length) {
    say('No browser connection was registered. Check --browsers or --user-data-dir and run setup again.');
    return false;
  }
  say(`1/3  Browser connection registered: ${written.map((m) => m.browser).join(', ')}.`);

  // Absolute paths work in desktop clients even when their PATH differs from the terminal's.
  const command = { command: process.execPath, args: [path.join(projectRoot(), 'dist', 'src', 'main.js')] };
  const clients = registerClients(command);
  say('2/3  MCP clients:');
  for (const client of clients) {
    const status = client.status === 'existing' ? 'already configured (existing settings kept)' : client.status === 'registered' ? 'registered' : 'registration failed — use the configuration below';
    say(`     ${client.name}: ${status}.`);
  }
  if (!clients.length) say('     No supported client CLI found. Add the configuration below to your MCP client.');
  say(`     Manual configuration (Cursor, Claude Desktop, or other clients):\n${JSON.stringify({ mcpServers: { 'opencli-mcp': command } }, null, 2)}`);

  say('3/3  Checking the Chrome extension connection…');
  let status = await doctor();
  if (!status.ok) {
    const opened = !opts.noOpen && await openStorePage();
    say(`     ${opened ? 'Opened the Chrome Web Store. Install or enable opencli-mcp in Chrome:' : 'Install or enable opencli-mcp in Chrome:'} ${EXTENSION_STORE_URL}`);
    say('     Already installed? Keep Chrome open; the extension reconnects automatically.');
    if (waitMs > 0) say(`     Waiting up to ${waitMs / 1000} seconds for the browser connection…`);
    const until = Date.now() + waitMs;
    while (!status.ok && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, Math.max(0, until - Date.now()))));
      status = await doctor();
    }
  }
  if (!status.ok) {
    say('Browser is not connected yet. Your registration has been saved.');
    for (const advice of status.advice) say(`     ${advice}`);
    say('If the extension is already enabled, disable and re-enable it in chrome://extensions. Then run `opencli-mcp setup` again.');
    return false;
  }
  say('Browser connected.');
  if (clients.some((client) => client.status === 'failed')) {
    say('MCP client setup is incomplete. Apply the configuration above or fix the client CLI and rerun setup.');
    return false;
  }
  if (!clients.length) say('Next: add the configuration above to your MCP client, then reconnect it.');
  else say('Setup complete for the clients listed above. Restart or reconnect your MCP client to load the tools.');
  return true;
}
