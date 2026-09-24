import { describe, expect, it } from 'vitest';
import { performAct, ActError, type ActIO } from '../src/shared/engine.js';

const resolved = { ok: true as const, x: 10, y: 20, matches_n: 1, tag: 'button', hit: 'target' as const, blocker: null, editable: false, checkable: false, checked: false, isSelect: false, ref: 'e1', selector: '#go', usedSelector: '#go' };

function fakeIo(landed: boolean): { io: ActIO; calls: string[] } {
  const calls: string[] = [];
  const io: ActIO = {
    async call(fn) {
      calls.push(fn);
      if (fn === 'resolve') return resolved;
      if (fn === 'readClickProbe') return landed;
      if (fn === 'domClick') return { ok: true, ref: 'e1', tag: 'button', selector: '#go', x: 0, y: 0 };
      if (fn === 'settle') return { waitedMs: 0, quiet: true };
      return null;
    },
    async cdp(method, params) { calls.push(`${method}:${String((params as { type?: string } | undefined)?.type ?? '')}`); },
  };
  return { io, calls };
}

describe('click delivery', () => {
  it('fails when the mouse event does not reach the page, and does not click again', async () => {
    const { io, calls } = fakeIo(false);
    await expect(performAct(io, { kind: 'click', target: { ref: 'e1' }, settleMs: 0 })).rejects.toMatchObject({ code: 'not_delivered' });
    expect(calls.filter((c) => c === 'domClick')).toEqual([]);
    expect(calls).toContain('armClickProbe');
    expect(calls).toContain('Input.dispatchMouseEvent:mousePressed');
  });
  it('treats a navigation as delivery when the probe reads false in the new document', async () => {
    const { io } = fakeIo(false);
    io.waitForNavigation = async () => ({ navigated: true, url: 'https://next.example/' });
    const r = await performAct(io, { kind: 'click', target: { ref: 'e1' }, settleMs: 0 });
    expect(r.navigated).toBe(true);
    expect(r.url).toBe('https://next.example/');
  });
  it('method dom sends no mouse event', async () => {
    const { io, calls } = fakeIo(true);
    const r = await performAct(io, { kind: 'click', target: { ref: 'e1' }, method: 'dom', settleMs: 0 });
    expect(r.method).toBe('dom');
    expect(calls[0]).toBe('domClick');
    expect(calls.some((c) => c.startsWith('Input.dispatchMouseEvent'))).toBe(false);
    await expect(performAct(io, { kind: 'press', target: { ref: 'e1' }, value: 'Enter', method: 'dom', settleMs: 0 })).rejects.toBeInstanceOf(ActError);
    await expect(performAct(io, { kind: 'click', target: { x: 1, y: 2 }, method: 'dom', settleMs: 0 })).rejects.toMatchObject({ code: 'invalid_args' });
  });
});
