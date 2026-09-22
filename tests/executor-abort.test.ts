import { describe, expect, it } from 'vitest';
import { runAdapter, type PageProvider } from '../src/sites/executor.js';
import type { AdapterCommand } from '../src/sites/loader.js';

const provider: PageProvider = {
  browserAvailable: () => false,
  getAdapterPage: async () => { throw new Error('no page'); },
  toolContext: async () => ({}),
};

function cmd(run: AdapterCommand['run']): AdapterCommand {
  return { site: 's', name: 'n', description: '', access: 'read', browser: false, args: [], source: 'builtin', run };
}

describe('runAdapter cancellation', () => {
  it('does not start the command when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    let started = false;
    const r = await runAdapter(provider, cmd(async () => { started = true; return { ok: true }; }), {}, { signal: ac.signal });
    expect(started).toBe(false);
    expect(r).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  });

  it('does not surface a rejection that races an abort during startup', async () => {
    const ac = new AbortController();
    const caught: unknown[] = [];
    const onRejection = (err: unknown) => { caught.push(err); };
    process.on('unhandledRejection', onRejection);
    try {
      const r = await runAdapter(provider, cmd(() => {
        ac.abort();
        return new Promise((_, rej) => { setTimeout(() => rej(new Error('late')), 30); });
      }), {}, { signal: ac.signal });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(r).toMatchObject({ ok: false, error: { code: 'cancelled' } });
      expect(caught).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
