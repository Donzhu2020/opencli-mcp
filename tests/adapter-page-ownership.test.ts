import { describe, expect, it, vi } from 'vitest';
import type { PageProvider } from '../src/sites/executor.js';
import type { AdapterCommand } from '../src/sites/loader.js';
import { Runtime } from '../src/runtime/runtime.js';

function cmd(run: AdapterCommand['run']): AdapterCommand {
  return { site: 's', name: 'n', description: '', access: 'read', args: [], source: 'builtin', run };
}

describe('site adapter page ownership', () => {
  it('runs complete calls to the same site sequentially', async () => {
    const rt = new Runtime();
    rt.browserAvailable = () => true;
    rt.getAdapterPage = async () => ({}) as Awaited<ReturnType<PageProvider['getAdapterPage']>>;
    rt.toolContext = async () => ({ tab: {}, sites: {}, recon: {} });
    const order: string[] = [];
    let finishFirst!: () => void;
    let firstStarted!: () => void;
    const gate = new Promise<void>((resolve) => { finishFirst = resolve; });
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    vi.spyOn(rt.registry, 'resolve').mockResolvedValue({ ...cmd(async ({ args }) => {
      order.push(`start:${args.id}`);
      if (args.id === 'one') { firstStarted(); await gate; }
      order.push(`end:${args.id}`);
      return args.id;
    }), args: [{ name: 'id', required: true }] });
    const first = rt.runSite('s', 'n', { id: 'one' });
    await started;
    const second = rt.runSite('s', 'n', { id: 'two' });
    await Promise.resolve();
    expect(order).toEqual(['start:one']);
    finishFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
  });
  it('retires a page when an adapter times out with an unknown outcome', async () => {
    const rt = new Runtime();
    let closed = 0;
    rt.browserAvailable = () => true;
    vi.spyOn(rt as unknown as { createPage: () => Promise<Awaited<ReturnType<PageProvider['getAdapterPage']>>> }, 'createPage').mockResolvedValue(({ closeWindow: async () => { closed += 1; } }) as Awaited<ReturnType<PageProvider['getAdapterPage']>>);
    rt.toolContext = async () => ({ tab: {}, sites: {}, recon: {} });
    vi.spyOn(rt.registry, 'resolve').mockResolvedValue(cmd(async () => new Promise(() => {})));
    const result = await rt.runSite('s', 'n', {}, { timeoutMs: 10 });
    expect(result).toMatchObject({ ok: false, error: { code: 'command_outcome_unknown' } });
    expect(closed).toBe(1);
  });
});
