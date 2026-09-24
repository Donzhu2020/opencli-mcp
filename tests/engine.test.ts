import { describe, expect, it } from 'vitest';
import { performAct, type ActIO } from '../src/shared/engine.js';

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
});
