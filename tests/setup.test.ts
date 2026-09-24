import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ registerHost: vi.fn(), doctor: vi.fn(), execFile: vi.fn(), execFileSync: vi.fn(), spawn: vi.fn() }));
vi.mock('../src/host/registration.js', () => ({ registerHost: mocks.registerHost, projectRoot: () => '/package with spaces' }));
vi.mock('../src/host/doctor.js', () => ({ doctor: mocks.doctor }));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile, execFileSync: mocks.execFileSync, spawn: mocks.spawn }));
import { setup } from '../src/host/setup.js';
import { EXTENSION_STORE_URL } from '../src/host/extension.js';

let output: string;
beforeEach(() => {
  vi.resetAllMocks();
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output += String(chunk); return true; });
  mocks.registerHost.mockReturnValue({ manifests: [{ browser: 'chrome', written: true }] });
  mocks.doctor.mockResolvedValue({ ok: false, advice: ['Enable the extension.'] });
  mocks.execFileSync.mockImplementation(() => { throw new Error('command not found'); });
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, '', ''));
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function clientCLI(options: { existing?: boolean; fail?: boolean } = {}) {
  mocks.execFileSync.mockImplementation((file: string, args: string[]) => {
    if (file === 'which' || file === 'where') {
      if (args[0] === 'codex') return '/bin/codex\n';
      throw new Error('not installed');
    }
    if (file === '/bin/codex') {
      if (args[1] === 'get' && !options.existing) throw new Error('not registered');
      if (args[1] === 'add' && options.fail) throw new Error('registration failed');
      return '';
    }
    throw new Error(`unexpected command ${file}`);
  });
}

describe('setup user flow', () => {
  it('opens the store on a fresh install and reports a disconnected browser without developer instructions', async () => {
    expect(await setup({ waitMs: 0, clients: ['manual'] })).toBe(false);
    const opened = [...mocks.execFile.mock.calls, ...mocks.spawn.mock.calls];
    expect(opened).toHaveLength(1);
    expect(opened[0][1]).toContain(EXTENSION_STORE_URL);
    expect(output).toContain('registration has been saved');
    expect(output).not.toMatch(/Load unpacked|Developer mode|clipboard|Setup complete/);
    expect(mocks.doctor).toHaveBeenCalledTimes(1);
  });

  it('registers a detected client with absolute paths and skips the store when connected', async () => {
    clientCLI();
    mocks.doctor.mockResolvedValue({ ok: true });
    expect(await setup({ waitMs: 0, clients: ['codex'] })).toBe(true);
    expect(mocks.execFileSync).toHaveBeenCalledWith('/bin/codex', ['mcp', 'add', 'opencli-mcp', '--', process.execPath, '/package with spaces/dist/src/main.js'], expect.anything());
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(output).toContain('Setup complete');
  });

  it('does not claim client setup succeeded after registration failure', async () => {
    clientCLI({ fail: true });
    mocks.doctor.mockResolvedValue({ ok: true });
    expect(await setup({ clients: ['codex'] })).toBe(false);
    expect(output).toContain('MCP client setup is incomplete');
    expect(output).not.toContain('Setup complete');
  });
});
