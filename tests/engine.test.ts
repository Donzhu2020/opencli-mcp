import { describe, expect, it } from 'vitest';
import { targetToSelector, fallbackSelector, installEngineJs, ENGINE_GLOBAL, performAct, ActError, type ActIO } from '../src/shared/engine.js';
import { INJECTED_SOURCE } from '../src/shared/injected-source.js';

describe('engine selector compilation (Playwright internal engines, as the ChatGPT plugin uses)', () => {
  it('compiles agent targets to Playwright selectors', () => {
    expect(targetToSelector({ ref: 12 })).toBeNull(); // numeric DOM-snapshot refs are gone: eN is the one ref space
    expect(targetToSelector({ ref: 'e12' })).toBe('aria-ref=e12');
    expect(targetToSelector({ selector: '#q', nth: 1 })).toBe('#q >> nth=1');
    expect(targetToSelector({ role: 'button', name: 'Submit' })).toBe('internal:role=button[name="Submit"i]');
    expect(targetToSelector({ role: 'link' })).toBe('internal:role=link');
    expect(targetToSelector({ label: 'Email' })).toBe('internal:label="Email"i');
    expect(targetToSelector({ text: 'More information' })).toBe('internal:text="More information"i');
    expect(targetToSelector({ testid: 'save' })).toBe('internal:testid=[data-testid="save"s]');
    expect(targetToSelector({})).toBeNull();
    expect(fallbackSelector({ label: 'Search' })).toBe('internal:attr=[placeholder="Search"i]');
  });
  it('ships the vendored injected script and an installer expression', () => {
    expect(INJECTED_SOURCE.length).toBeGreaterThan(100_000);
    expect(INJECTED_SOURCE).toContain('InjectedScript');
    const js = installEngineJs(INJECTED_SOURCE, 'globalThis.__opencliPage = {};');
    expect(js).toContain(`globalThis.${ENGINE_GLOBAL}`);
    expect(js).toContain('globalThis.__opencliPage = {};');
    expect(js).toContain("testIdAttributeName: 'data-testid'");
  });
});

describe('page calls and frame steps', () => {
  it('builds a page-module call from a function name and JSON args', async () => {
    const { pageCallJs, frameSteps } = await import('../src/shared/engine.js');
    expect(pageCallJs('find', { selector: 'a"b', limit: 3 })).toBe('globalThis.__opencliPage.find({"selector":"a\\"b","limit":3})');
    expect(pageCallJs('clearActMark', undefined)).toBe('globalThis.__opencliPage.clearActMark()');
    expect(() => pageCallJs('x; y', {})).toThrow();
    expect(frameSteps('#outer >> internal:control=enter-frame >> #inner')).toEqual(['#outer', '#inner']);
    expect(frameSteps(['#a', 1])).toEqual(['#a', 1]);
  });
});

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
  it('returns after a delivered mouse event', async () => {
    const { io, calls } = fakeIo(true);
    const r = await performAct(io, { kind: 'click', target: { ref: 'e1' }, settleMs: 0 });
    expect(r.method).toBe('cdp');
    expect(calls).not.toContain('domClick');
  });
  it('treats a navigation as delivery when the probe reads false in the new document', async () => {
    const { io } = fakeIo(false);
    io.waitForNavigation = async () => ({ navigated: true, url: 'https://next.example/' });
    const r = await performAct(io, { kind: 'click', target: { ref: 'e1' }, settleMs: 0 });
    expect(r.navigated).toBe(true);
    expect(r.url).toBe('https://next.example/');
  });
  it('does not report success when the probe cannot be read and nothing navigated', async () => {
    const { io } = fakeIo(true);
    io.call = async (fn) => {
      if (fn === 'resolve') return resolved;
      if (fn === 'readClickProbe') throw new Error('timeout');
      if (fn === 'settle') return { waitedMs: 0, quiet: true };
      return null;
    };
    io.waitForNavigation = async () => ({ navigated: false });
    await expect(performAct(io, { kind: 'click', target: { ref: 'e1' }, settleMs: 0 })).rejects.toMatchObject({ code: 'not_delivered' });
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
