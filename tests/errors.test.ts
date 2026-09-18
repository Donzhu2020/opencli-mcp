import { describe, expect, it } from 'vitest';
import { normalizeErrorCode } from '../src/api/errors.js';

describe('one error vocabulary (normalizeErrorCode)', () => {
  it('maps corpus/adapter codes to the object-model families', () => {
    expect(normalizeErrorCode('TIMEOUT')).toBe('timeout');
    expect(normalizeErrorCode('COMMAND_EXEC')).toBe('command_failed');
    expect(normalizeErrorCode('BROWSER_CONNECT')).toBe('browser_unavailable');
    expect(normalizeErrorCode('TargetError')).toBe('not_found');
  });
  it('leaves object-model codes untouched', () => {
    for (const c of ['not_found', 'stale_ref', 'expectation_failed', 'needs_confirmation', 'user_declined']) {
      expect(normalizeErrorCode(c)).toBe(c);
    }
  });
  it('snake-cases any other SCREAMING_SNAKE / CamelCase code so there is one vocabulary', () => {
    expect(normalizeErrorCode('SOME_NEW_CODE')).toBe('some_new_code');
    expect(normalizeErrorCode('BrowserCommandError')).toBe('browser_command_error');
    expect(normalizeErrorCode('')).toBe('error');
    expect(normalizeErrorCode(undefined)).toBe('error');
  });
});
