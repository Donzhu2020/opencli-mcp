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
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

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
    expect(await setup({ waitMs: 0 })).toBe(false);
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
    expect(await setup({ waitMs: 0 })).toBe(true);
    expect(mocks.execFileSync).toHaveBeenCalledWith('/bin/codex', ['mcp', 'add', 'opencli-mcp', '--', process.execPath, '/package with spaces/dist/src/main.js'], expect.anything());
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(output).toContain('Setup complete');
  });

  it('keeps existing client settings when rerun', async () => {
    clientCLI({ existing: true });
    mocks.doctor.mockResolvedValue({ ok: true });
    expect(await setup()).toBe(true);
    expect(mocks.execFileSync.mock.calls.some(([, args]) => args[1] === 'add')).toBe(false);
    expect(output).toContain('existing settings kept');
  });

  it('does not claim client setup succeeded after registration failure', async () => {
    clientCLI({ fail: true });
    mocks.doctor.mockResolvedValue({ ok: true });
    expect(await setup()).toBe(false);
    expect(output).toContain('MCP client setup is incomplete');
    expect(output).not.toContain('Setup complete');
  });

  it('gives manual clients their remaining step instead of claiming full completion', async () => {
    mocks.doctor.mockResolvedValue({ ok: true });
    expect(await setup()).toBe(true);
    expect(output).toContain('Next: add the configuration above');
    expect(output).not.toContain('Setup complete');
  });

  it('honors --no-open and checks once with --wait 0', async () => {
    expect(await setup({ noOpen: true, waitMs: 0 })).toBe(false);
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.doctor).toHaveBeenCalledTimes(1);
    expect(output).toContain(EXTENSION_STORE_URL);
  });

  it('survives a failed browser opener and prints a usable link', async () => {
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(new Error('browser missing')));
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('browser missing')));
      return child;
    });
    expect(await setup({ waitMs: 0 })).toBe(false);
    expect(output).toContain(EXTENSION_STORE_URL);
    expect(output).not.toContain('Opened the Chrome Web Store');
  });

  it('waits for an already installed extension to reconnect', async () => {
    vi.useFakeTimers();
    mocks.doctor.mockResolvedValueOnce({ ok: false, advice: [] }).mockResolvedValue({ ok: true });
    const result = setup({ noOpen: true, waitMs: 2500 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBe(true);
    expect(output).toContain('Browser connected.');
  });

  it.each([-1, NaN, Infinity])('rejects invalid wait %s before changing any configuration', async (waitMs) => {
    await expect(setup({ waitMs })).rejects.toThrow('--wait');
    expect(mocks.registerHost).not.toHaveBeenCalled();
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it('does not register clients when no browser target was registered', async () => {
    mocks.registerHost.mockReturnValue({ manifests: [] });
    expect(await setup({ browsers: ['edge'] })).toBe(false);
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    expect(mocks.doctor).not.toHaveBeenCalled();
  });
});
