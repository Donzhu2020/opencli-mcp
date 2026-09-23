import { describe, expect, it } from 'vitest';
import { ActionError, errorEnvelope } from '../src/api/errors.js';
import { errors } from 'opencli-mcp/adapter-sdk';

describe('error envelopes', () => {
  it('preserves native runtime and adapter codes with their recovery details', () => {
    expect(errorEnvelope(new ActionError('invalid_args', 'Missing query', 'Provide query', { details: { field: 'query' } }))).toEqual({
      ok: false, error: { code: 'invalid_args', message: 'Missing query', hint: 'Provide query', details: { field: 'query' } },
    });
    expect(errorEnvelope(errors.argument('Bad query')).error).toMatchObject({ code: 'invalid_args', message: 'Bad query' });
  });
  it('reports unstructured thrown values', () => {
    expect(errorEnvelope(null)).toEqual({ ok: false, error: { code: 'error', message: 'null' } });
    expect(errorEnvelope('failed')).toEqual({ ok: false, error: { code: 'error', message: 'failed' } });
  });
});
