import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import { registerOpenCode } from '../src/host/opencode.js';
import { registerPi } from '../src/host/pi.js';

const dirs: string[] = [];
function tempDir(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-client-config-')); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const command = { command: '/path with spaces/node', args: ['/package with spaces/main.js'] };

it('adds OpenCode once without changing existing JSONC settings', () => {
  const home = tempDir();
  const file = path.join(home, 'opencode', 'opencode.jsonc');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '{\n  // keep this comment\n  "theme": "dark",\n}\n');
  expect(registerOpenCode(command, home)).toBe('registered');
  const first = fs.readFileSync(file, 'utf8');
  expect(registerOpenCode(command, home)).toBe('existing');
  expect(fs.readFileSync(file, 'utf8')).toBe(first);
  expect(first).toContain('// keep this comment');
  expect(parse(first).mcp['opencli-mcp']).toEqual({ type: 'local', command: [command.command, ...command.args, 'stdio'], enabled: true });
});

it('adds Pi alongside other MCP servers and preserves invalid files', () => {
  const dir = tempDir();
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, '{\n  // keep Pi settings\n  "mcpServers": { "other": { "command": "echo" } },\n}\n');
  expect(registerPi(command, dir)).toBe('registered');
  const updated = fs.readFileSync(file, 'utf8');
  expect(updated).toContain('// keep Pi settings');
  expect(parse(updated).mcpServers.other).toEqual({ command: 'echo' });
  expect(parse(updated).mcpServers['opencli-mcp']).toEqual({ command: command.command, args: [...command.args, 'stdio'], protocolVersion: 'auto' });
  fs.writeFileSync(file, '{ broken');
  expect(() => registerPi(command, dir)).toThrow('Cannot read MCP config');
  expect(fs.readFileSync(file, 'utf8')).toBe('{ broken');
});
