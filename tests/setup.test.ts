import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ registerHost: vi.fn(), doctor: vi.fn(), execFile: vi.fn(), execFileSync: vi.fn(), spawn: vi.fn(), question: vi.fn(), close: vi.fn() }));
vi.mock('../src/host/registration.js', () => ({ registerHost: mocks.registerHost, projectRoot: () => '/package with spaces' }));
vi.mock('../src/host/doctor.js', () => ({ doctor: mocks.doctor }));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile, execFileSync: mocks.execFileSync, spawn: mocks.spawn }));
vi.mock('node:readline/promises', () => ({ createInterface: () => ({ question: mocks.question, close: mocks.close, on: vi.fn() }) }));
import { setup } from '../src/host/setup.js';
import { EXTENSION_STORE_URL } from '../src/host/extension.js';

let output: string;
const terminalDescriptors = [process.stdin, process.stdout].map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
function terminal(value: boolean): void {
  for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, 'isTTY', { value, writable: true, configurable: true });
}
beforeEach(() => {
  vi.resetAllMocks();
  output = '';
  terminal(false);
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
  vi.useRealTimers(); vi.restoreAllMocks();
  [process.stdin, process.stdout].forEach((stream, index) => {
    const descriptor = terminalDescriptors[index];
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else Reflect.deleteProperty(stream, 'isTTY');
  });
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
    expect(await setup({ waitMs: 0, clients: ['codex'] })).toBe(true);
    expect(mocks.execFileSync).toHaveBeenCalledWith('/bin/codex', ['mcp', 'add', 'opencli-mcp', '--', process.execPath, '/package with spaces/dist/src/main.js'], expect.anything());
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(output).toContain('Setup complete');
  });

  it('keeps existing client settings when rerun', async () => {
    clientCLI({ existing: true });
    mocks.doctor.mockResolvedValue({ ok: true });
    expect(await setup({ clients: ['codex'] })).toBe(true);
    expect(mocks.execFileSync.mock.calls.some(([, args]) => args[1] === 'add')).toBe(false);
    expect(output).toContain('existing settings kept');
  });

  it('does not claim client setup succeeded after registration failure', async () => {
    clientCLI({ fail: true });
    mocks.doctor.mockResolvedValue({ ok: true });
    expect(await setup({ clients: ['codex'] })).toBe(false);
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
    expect(mocks.execFileSync.mock.calls.some(([, args]) => args[0] === 'mcp')).toBe(false);
    expect(mocks.doctor).not.toHaveBeenCalled();
  });
});


describe('client selection', () => {
  it('does not modify detected clients without a selection in a non-interactive terminal', async () => {
    clientCLI();
    mocks.doctor.mockResolvedValue({ ok: true });
    await setup();
    expect(mocks.execFileSync.mock.calls.some(([, args]) => args[0] === 'mcp')).toBe(false);
    expect(output).toContain('--clients');
  });

  it('skips client configuration explicitly', async () => {
    mocks.doctor.mockResolvedValue({ ok: true });
    expect(await setup({ clients: ['none'] })).toBe(true);
    expect(output).not.toContain('mcpServers');
    expect(output).toContain('MCP client settings were not changed');
  });

  it.each([['unknown'], ['codex'], ['none', 'codex'], ['']])('rejects invalid or unavailable selection %j before writes', async (...clients) => {
    await expect(setup({ clients })).rejects.toThrow();
    expect(mocks.registerHost).not.toHaveBeenCalled();
  });

  it('asks before making changes and configures only the selected client', async () => {
    terminal(true);
    clientCLI();
    mocks.doctor.mockResolvedValue({ ok: true });
    mocks.question.mockImplementation(async () => {
      expect(mocks.registerHost).not.toHaveBeenCalled();
      return 'codex';
    });
    expect(await setup()).toBe(true);
    expect(mocks.question).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalled();
    expect(mocks.execFileSync.mock.calls.filter(([, args]) => args[1] === 'add')).toHaveLength(1);
  });

  it('cancels without changing configuration', async () => {
    terminal(true);
    mocks.question.mockRejectedValue(new Error('aborted'));
    await expect(setup()).rejects.toThrow('cancelled');
    expect(mocks.registerHost).not.toHaveBeenCalled();
  });
});
