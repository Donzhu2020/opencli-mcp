import { describe, expect, it } from 'vitest';
import { transformCode, JsSession } from '../src/mcp/js-session.js';

describe('js session', () => {
  it('rewrites top-level declarations and returns the last expression', () => {
    const t = transformCode(`const a = 1;\nlet b = a + 1;\nconst { x, y } = { x: 1, y: 2 };\nfunction f() { const inner = 3; return inner; }\nb + x + f()`);
    expect(t).toContain('a = 1;'); expect(t).toContain('b = a + 1;'); expect(t).toContain('({ x, y } = { x: 1, y: 2 });');
    expect(t).toContain('const inner = 3'); expect(t.trim().endsWith('return (b + x + f());')).toBe(true);
  });
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
  it('returns image values as image blocks', async () => {
    const s = new JsSession({ shot: () => ({ __image: true, mimeType: 'image/png', base64: 'QUJD' }) });
    const r = await s.run('shot()');
    expect(r.images).toHaveLength(1); expect(r.value).toMatchObject({ image: expect.stringContaining('image/png') });
  });
});

describe('js session transform edge cases', () => {
  it('does not rewrite declarations inside template literals and returns multi-line last statements', async () => {
    const s = new JsSession({ tab: { act: async (o: unknown) => ({ ok: true, o }) } });
    const r1 = await s.run("const js = `\nconst x = document.title;\nreturn x;`;\njs");
    expect(r1.value).toBe('\nconst x = document.title;\nreturn x;');
    const r2 = await s.run('await tab.act({\n  action: "click",\n  target: { text: "x" },\n});');
    expect(r2.value).toMatchObject({ ok: true });
    const r3 = await s.run('let a, b;\na = 1; b = 2;\na + b');
    expect(r3.value).toBe(3);
    // several top-level statements on one line: every declaration persists and the last expression is returned
    const r4 = await s.run('const b0 = 20; const t0 = b0 + 1; t0 * 2');
    expect(r4.value).toBe(42);
    const r5 = await s.run('t0');
    expect(r5.value).toBe(21);
  });
});
