import { describe, expect, it } from 'vitest';
import { Policy } from '../src/runtime/policy.js';

describe('policy shapes', () => {
  it('is permissive by default', () => {
    const p = new Policy();
    expect(p.checkOrigin('https://x.test/').allowed).toBe(true);
    expect(p.checkWrite('twitter/post', false).allowed).toBe(true);
  });
  it('asks for new origins and confirmations when enabled', () => {
    const p = new Policy({ askNewOrigins: true, confirmWrites: true, allowedHosts: ['example.com'] });
    expect(p.checkOrigin('https://sub.example.com/a').allowed).toBe(true);
    const d = p.checkOrigin('https://new.test/');
    expect(d).toMatchObject({ allowed: false, code: 'needs_origin_approval', retryable: true });
    p.allowHost('new.test');
    expect(p.checkOrigin('https://new.test/').allowed).toBe(true);
    expect(p.checkWrite('twitter/post', false)).toMatchObject({ allowed: false, code: 'needs_confirmation' });
    expect(p.checkWrite('twitter/post', true).allowed).toBe(true);
    expect(() => Policy.throwIfDenied(p.checkWrite('x', false))).toThrow(/confirm/);
  });
});
