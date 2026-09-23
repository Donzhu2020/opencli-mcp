import { afterEach, describe, expect, it, vi } from 'vitest';
import { __test__, executeWithJournal } from '../extension/src/journal.js';

afterEach(() => { __test__.reset(); vi.unstubAllGlobals(); });

describe('command journal', () => {
  it('persists started before execution and done before returning a result', async () => {
    let finishStart;
    let finishDone;
    const set = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishStart = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishDone = resolve; }));
    vi.stubGlobal('chrome', { storage: { session: { get: vi.fn(async () => ({})), set } } });
    const execute = vi.fn(async () => ({ id: 'action-1', ok: true, data: { clicked: true } }));
    const cmd = { id: 'action-1', action: 'act' };
    const result = executeWithJournal(cmd, execute);
    const duplicate = executeWithJournal(cmd, execute);
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0][0].opencli_command_journal_v1['action-1'].status).toBe('started');
    expect(execute).not.toHaveBeenCalled();
    finishStart();
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0].opencli_command_journal_v1['action-1'].status).toBe('started');
    expect(set.mock.calls[1][0].opencli_command_journal_v1['action-1'].status).toBe('done');
    finishDone();
    expect(await result).toEqual({ id: 'action-1', ok: true, data: { clicked: true } });
    expect(await duplicate).toEqual(await result);
  });
});
