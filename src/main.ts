#!/usr/bin/env node
/**
 * opencli-mcp — entry point.
 *   opencli-mcp                 stdio MCP (proxies to the Chrome-spawned host, else embedded runtime)
 *   opencli-mcp host --native   the Native Messaging host (spawned by Chrome; do not run by hand)
 *   opencli-mcp serve [--port]  HTTP MCP with an embedded runtime (dev / CDP-only)
 *   opencli-mcp setup           first run in one go: install + register with Claude Code + open chrome://extensions + wait
 *   opencli-mcp install         write the Native Messaging manifest + stable extension ID
 *   opencli-mcp uninstall
 *   opencli-mcp doctor
 *   opencli-mcp extension-path  print the unpacked extension directory
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
function findVersion(): string {
  let dir = here;
  for (let i = 0; i < 6; i++) { const pkg = path.join(dir, 'package.json'); try { const j = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { name?: string; version?: string }; if (j.name === 'opencli-mcp' && j.version) return j.version; } catch { /* walk */ } dir = path.dirname(dir); }
  return '0.0.0';
}
const VERSION = findVersion();

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'stdio';
const flag = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string): boolean => argv.includes(name);

async function main(): Promise<void> {
  switch (cmd) {
    case 'stdio': case '--stdio': {
      const { runStdio } = await import('./launcher/stdio.js');
      await runStdio({ version: VERSION, forceEmbedded: has('--embedded') });
      return;
    }
    case 'host': {
      const { runNativeHost } = await import('./host/host.js');
      await runNativeHost({ version: VERSION });
      return;
    }
    case 'serve': {
      const { Runtime } = await import('./runtime/runtime.js');
      const { startHttpServer } = await import('./host/http.js');
      const { loadOrCreateToken, readConfig } = await import('./host/state.js');
      const config = readConfig();
      const rt = new Runtime({ sites: config.sites, sitesWrite: config.sitesWrite, log: (m) => process.stderr.write(`[opencli-mcp] ${m}\n`) });
      await rt.init();
      const token = has('--no-auth') ? '' : loadOrCreateToken();
      const h = await startHttpServer(rt, { port: Number(flag('--port') ?? 0), token, version: VERSION, allowNoAuth: has('--no-auth') });
      process.stderr.write(`[opencli-mcp] serving http://${h.host}:${h.port}/mcp${token ? ' (Authorization: Bearer <~/.opencli-mcp/token>)' : ' (no auth)'}\n`);
      return;
    }
    case 'setup': {
      const { setup } = await import('./host/setup.js');
      process.exitCode = (await setup({ noOpen: has('--no-open'), waitMs: flag('--wait') ? Number(flag('--wait')) * 1000 : undefined })) ? 0 : 1;
      return;
    }
    case 'install': {
      const { install } = await import('./host/install.js');
      const browsers = flag('--browsers')?.split(',');
      const r = install({ browsers, extensionId: flag('--extension-id'), userDataDirs: flag('--user-data-dir')?.split(',') });
      const written = r.manifests.filter((m) => m.written);
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n\nWrote ${written.length} host manifest(s): ${written.map((m) => m.browser).join(', ') || 'none'} (running custom profiles are detected automatically; add --user-data-dir for others).\nNext: chrome://extensions → Developer mode → Load unpacked → ${r.extensionDir}\nThe extension ID will be ${r.extensionId}. If the extension was already loaded, reload it. Then run: opencli-mcp doctor\n`);
      return;
    }
    case 'uninstall': {
      const { uninstall } = await import('./host/install.js');
      process.stdout.write(`${JSON.stringify({ removed: uninstall() }, null, 2)}\n`);
      return;
    }
    case 'doctor': {
      const { doctor } = await import('./host/doctor.js');
      const r = await doctor();
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    case 'extension-path': {
      const { extensionDir } = await import('./host/install.js');
      process.stdout.write(`${extensionDir()}\n`);
      return;
    }
    case 'version': case '--version': case '-V': process.stdout.write(`${VERSION}\n`); return;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n${['stdio', 'host --native', 'serve [--port N] [--no-auth]', 'setup [--no-open] [--wait seconds]', 'install [--browsers chrome,edge] [--user-data-dir /path/to/profile]', 'uninstall', 'doctor', 'extension-path', 'version'].map((c) => `  opencli-mcp ${c}`).join('\n')}\n`);
      process.exitCode = 2;
  }
}

main().catch((err) => { process.stderr.write(`[opencli-mcp] fatal: ${(err as Error).stack ?? err}\n`); process.exit(1); });
