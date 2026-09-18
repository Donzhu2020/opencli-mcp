import { describe, expect, it } from 'vitest';
import { targetToSelector, fallbackSelector, installEngineJs, ENGINE_GLOBAL } from '../src/shared/engine.js';
import { INJECTED_SOURCE } from '../src/shared/injected-source.js';

describe('engine selector compilation (Playwright internal engines, as the ChatGPT plugin uses)', () => {
  it('compiles agent targets to Playwright selectors', () => {
    expect(targetToSelector({ ref: 12 })).toBeNull(); // numeric DOM-snapshot refs are gone: eN is the one ref space
    expect(targetToSelector({ ref: 'e12' })).toBe('aria-ref=e12');
    expect(targetToSelector({ css: '#q', nth: 1 })).toBe('#q >> nth=1');
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
