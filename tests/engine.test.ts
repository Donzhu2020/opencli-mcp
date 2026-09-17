import { describe, expect, it } from 'vitest';
import { targetToSelector, fallbackSelector, installEngineJs, ENGINE_GLOBAL } from '../src/shared/engine.js';
import { INJECTED_SOURCE } from '../src/shared/injected-source.js';

describe('engine selector compilation (Playwright internal engines, as the ChatGPT plugin uses)', () => {
  it('compiles agent targets to Playwright selectors', () => {
    expect(targetToSelector({ ref: 12 })).toBe('[data-opencli-ref="12"]');
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
    const js = installEngineJs(INJECTED_SOURCE);
    expect(js).toContain(`globalThis.${ENGINE_GLOBAL}`);
    expect(js).toContain("testIdAttributeName: 'data-testid'");
  });
});
