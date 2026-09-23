// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';

it('settles an interrupted cursor move and reports arrival for the replacement', async () => {
  const frames = new Map();
  let nextFrame = 1;
  const listeners = [];
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-extension',
      getURL: (path) => `chrome-extension://test-extension/${path}`,
      sendMessage: async () => ({}),
      onMessage: { addListener: (listener) => { listeners.push(listener); } },
    },
  });
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback) => { frames.set(nextFrame, callback); return nextFrame++; });
  vi.stubGlobal('cancelAnimationFrame', (id) => { frames.delete(id); });
  vi.spyOn(performance, 'now').mockReturnValue(0);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) });
  await import('../extension/src/content/cursor.js');
  const send = (seq, x, y, animate) => new Promise((resolve) => {
    expect(listeners[0]({ type: 'opencli:cursor-state', state: { x, y, seq, visible: true, animate } }, {}, resolve)).toBe(true);
  });
  expect(await send(1, 20, 20, false)).toEqual({ arrived: true, seq: 1 });
  const interrupted = send(2, 300, 200, true);
  expect(frames.size).toBe(1);
  const replacement = send(3, 400, 100, true);
  expect(await interrupted).toEqual({ arrived: false, seq: 2 });
  while (frames.size) {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(1000);
  }
  expect(await replacement).toEqual({ arrived: true, seq: 3 });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
