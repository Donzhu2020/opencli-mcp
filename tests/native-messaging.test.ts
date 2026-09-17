import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { encodeFrame, FrameDecoder, NativeChannel } from '../src/host/native-messaging.js';

describe('native messaging framing', () => {
  it('round-trips and handles split/merged chunks', () => {
    const d = new FrameDecoder();
    const a = encodeFrame({ type: 'hello', n: 1 }); const b = encodeFrame({ type: 'result', result: { id: 'x', ok: true } });
    const all = Buffer.concat([a, b]);
    const out = [...d.push(all.subarray(0, 3)), ...d.push(all.subarray(3, a.length + 2)), ...d.push(all.subarray(a.length + 2))];
    expect(out).toEqual([{ type: 'hello', n: 1 }, { type: 'result', result: { id: 'x', ok: true } }]);
  });
  it('channel emits messages and sends frames', async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const ch = new NativeChannel(input, output);
    const got = new Promise((r) => ch.once('message', r));
    input.write(encodeFrame({ hi: true }));
    expect(await got).toEqual({ hi: true });
    ch.send({ cmd: 1 });
    const buf = output.read() as Buffer;
    expect(buf.readUInt32LE(0)).toBe(Buffer.from('{"cmd":1}').length);
  });
});
