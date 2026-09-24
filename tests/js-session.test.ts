import { describe, expect, it } from 'vitest';
import { JsSession } from '../src/mcp/js-session.js';

describe('js session', () => {
  it('persists state across calls and captures writes/images', async () => {
    const s = new JsSession({ agent: { hello: () => 'hi' } });
    const r1 = await s.run('const n = 41;\nn + 1');
    expect(r1.value).toBe(42);
    const r2 = await s.run('nodeRepl.write("w");\nawait nodeRepl.emitImage({ base64: "AAAA", mimeType: "image/png" });\nn');
    expect(r2.value).toBe(41); expect(r2.writes).toEqual(['w']); expect(r2.images[0].mimeType).toBe('image/png');
    const r3 = await s.run('agent.hello()');
    expect(r3.value).toBe('hi');
    const r4 = await s.run('throw new Error("boom")');
    expect(r4.error?.message).toBe('boom');
    s.reset();
    const r5 = await s.run('typeof n');
    expect(r5.value).toBe('undefined');
  });
  it('keeps concurrent call output with the call that wrote it', async () => {
    let resume!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const s = new JsSession({ wait: async () => { started(); await gate; } });
    const first = s.run('nodeRepl.write("first"); await wait(); nodeRepl.write("after"); 1');
    await entered;
    const second = await s.run('nodeRepl.write("second"); 2');
    resume();
    expect((await first).writes).toEqual(['first', 'after']);
    expect(second.writes).toEqual(['second']);
  });
});
