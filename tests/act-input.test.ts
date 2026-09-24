import { describe, expect, it } from 'vitest';
import { checkActInput, checkExpect } from '../src/mcp/act-input.js';
import { ActionError } from '../src/api/errors.js';

function err(fn: () => void): ActionError {
  try { fn(); } catch (e) { if (e instanceof ActionError) return e; throw e; }
  throw new Error('expected ActionError');
}

describe('tab_act input', () => {
  it('accepts one locator and rejects a mix', () => {
    expect(checkActInput({ action: 'click', target: { ref: 'e3' } }).target).toEqual({ ref: 'e3' });
    expect(checkActInput({ action: 'click', target: { role: 'button', name: 'Save' } }).target).toMatchObject({ role: 'button', name: 'Save' });
    expect(err(() => checkActInput({ action: 'click', target: { label: 'A', text: 'B' } })).message).toMatch(/mixes label and text/);
    expect(err(() => checkActInput({ action: 'click', target: { x: 1, y: 2, frame: '#f' } })).message).toMatch(/point cannot take frame/);
    const mixed = err(() => checkActInput({ action: 'click', target: { ref: 'e3', selector: '#a' } }));
    expect(mixed.code).toBe('invalid_args');
    expect(mixed.data?.details).toMatchObject({ expected: { action: 'click' } });
  });

  it('does not default press to Enter or fill to empty', () => {
    expect(err(() => checkActInput({ action: 'press', target: { ref: 'e1' } })).message).toMatch(/non-empty value/);
    expect(err(() => checkActInput({ action: 'fill', target: { ref: 'e1' } })).message).toMatch(/needs value/);
    expect(checkActInput({ action: 'fill', target: { ref: 'e1' }, value: '' }).target).toEqual({ ref: 'e1' });
    expect(err(() => checkActInput({ action: 'click', target: { ref: 'e1' }, value: 'x' })).message).toMatch(/does not take value/);
  });
});
