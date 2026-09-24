import { describe, expect, it } from 'vitest';
import { argsToShape, coerceArgs, validateArgDefinitions, type Arg } from '../src/sites/schema.js';
import { ActionError } from '../src/api/errors.js';
import { SiteRegistry } from '../src/sites/loader.js';
import { defaultSources } from '../src/lib/sources.js';
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

describe('SourceLoader', () => {
  it('searches across the index and rejects an unknown command', async () => {
    const r = new SiteRegistry(defaultSources());
    await r.load();
    const hits = await r.search('twitter bookmarks');
    expect(hits[0]?.site).toBe('twitter');
    expect(hits[0]?.args).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'limit', type: 'int', default: 20 })]));
    expect((await r.search('在 B站 搜索视频'))[0]).toMatchObject({ site: 'bilibili', name: 'search' });
    await expect(r.resolve('twitter', 'nope')).rejects.toMatchObject({ code: 'unknown_command' });
  });
});
