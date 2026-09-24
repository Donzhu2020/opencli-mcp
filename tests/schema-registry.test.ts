import { describe, expect, it } from 'vitest';
import { argsToShape, coerceArgs, validateArgDefinitions, type Arg } from '../src/sites/schema.js';
import { ActionError } from '../src/api/errors.js';
import { z } from 'zod';

describe('schema', () => {
  it('uses one nested JSON contract for schema and execution', () => {
    const args: Arg[] = [{ name: 'filter', type: 'object', required: true, properties: {
      tags: { type: 'array', items: { type: 'string', minLength: 2 }, min: 1, required: true },
      mode: { type: 'string', choices: ['new', 'hot'], required: true },
    } }];
    validateArgDefinitions(args);
    const schema = z.object(argsToShape(args));
    const valid = { filter: { tags: ['ab'], mode: 'hot' } };
    expect(schema.parse(valid)).toEqual(valid);
    expect(coerceArgs(args, valid)).toEqual(valid);
    expect(() => schema.parse({ filter: { tags: ['a'], mode: 'hot' } })).toThrow();
    expect(() => coerceArgs(args, { filter: { tags: ['a'], mode: 'hot' } })).toThrow(ActionError);
    expect(() => validateArgDefinitions([{ name: 'broken', type: 'array', items: { type: 'object', properties: { x: { type: 'array' } } } }])).toThrow(/needs items/);
  });
});
