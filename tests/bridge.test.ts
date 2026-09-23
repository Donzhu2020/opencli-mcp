import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ExtensionBridge } from '../src/host/bridge.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import type { NativeChannel } from '../src/host/native-messaging.js';

describe('extension protocol handshake', () => {
  it('rejects an incompatible extension before sending any command', async () => {
    const channel = new EventEmitter() as NativeChannel;
    channel.send = vi.fn();
    const bridge = new ExtensionBridge(channel);
    bridge.ready = { version: '0.0.12', port: 19991 };
    channel.emit('message', { type: 'hello', extensionVersion: '0.0.9', protocolVersion: PROTOCOL_VERSION - 1 });
    expect(bridge.connected).toBe(false);
    expect(bridge.protocolVersion).toBe(PROTOCOL_VERSION - 1);
    await expect(bridge.send('ping')).rejects.toMatchObject({ code: 'protocol_mismatch' });
    expect(channel.send).not.toHaveBeenCalled();
    channel.emit('message', { type: 'hello', extensionVersion: '0.0.13', protocolVersion: PROTOCOL_VERSION });
    expect(bridge.connected).toBe(true);
    expect(channel.send).toHaveBeenCalledWith({ type: 'ready', version: '0.0.12', port: 19991 });
  });
});
