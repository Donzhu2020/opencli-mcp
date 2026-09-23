import { describe, expect, it } from 'vitest';
import { runAdapter, type PageProvider } from '../src/sites/executor.js';
import type { AdapterCommand } from '../src/sites/loader.js';

const provider: PageProvider = {
  browserAvailable: () => true,
  getAdapterPage: async () => ({}) as Awaited<ReturnType<PageProvider['getAdapterPage']>>,
  toolContext: async () => ({}),
};

function cmd(run: AdapterCommand['run']): AdapterCommand {
  return { site: 's', name: 'n', description: '', access: 'read', args: [], source: 'builtin', run };
}

describe('runAdapter cancellation', () => {
  it('requires the connected browser for every adapter', async () => {
    const r = await runAdapter({ ...provider, browserAvailable: () => false }, cmd(async () => ({ ok: true })), {});
    expect(r).toMatchObject({ ok: false, error: { code: 'browser_unavailable' } });
  });

  it('does not start the command when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    let started = false;
    const r = await runAdapter(provider, cmd(async () => { started = true; return { ok: true }; }), {}, { signal: ac.signal });
    expect(started).toBe(false);
    expect(r).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  });

  it('does not start the command if cancelled while provisioning its page', async () => {
    const ac = new AbortController();
    let started = false;
    const r = await runAdapter({
      ...provider,
      getAdapterPage: async () => { ac.abort(); return {} as Awaited<ReturnType<PageProvider['getAdapterPage']>>; },
    }, cmd(async () => { started = true; return { ok: true }; }), {}, { signal: ac.signal });
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
