import { describe, expect, it } from 'vitest';
import { argsToShape, argSpec, coerceArgs, omitCliArgs, type Arg } from '../src/sites/schema.js';
import { ActionError } from '../src/api/errors.js';
import { SiteRegistry } from '../src/sites/loader.js';
import { defaultSources } from '../src/lib/sources.js';
import { z } from 'zod';

describe('schema', () => {
  it('maps adapter args to zod and coerces', () => {
    const args: Arg[] = [{ name: 'limit', type: 'int', default: 20, help: 'n' }, { name: 'q', required: true }, { name: 'sort', choices: ['hot', 'new'] }];
    const shape = z.object(argsToShape(args));
    expect(shape.parse({ q: 'x', limit: 3 })).toEqual({ q: 'x', limit: 3 });
    expect(() => shape.parse({ limit: 3 })).toThrow();
    expect(coerceArgs(args, { q: 'x', limit: '5', sort: 'hot' })).toEqual({ q: 'x', limit: 5, sort: 'hot' });
    expect(() => coerceArgs(args, { q: 'x', sort: 'weird' })).toThrow(/one of/);
    expect(() => coerceArgs(args, {})).toThrow(ActionError);
  });

  it('hides CLI-only args from the agent schema but still coerces them when passed', () => {
    const args: Arg[] = [{ name: 'q', required: true }, { name: 'output-file', help: 'write jsonl' }, { name: 'limit', type: 'int', default: 5 }];
    expect(Object.keys(z.object(argsToShape(args)).shape)).toEqual(['q', 'limit']);
    expect(argSpec(args).map((a) => a.name)).toEqual(['q', 'limit']);
    expect(omitCliArgs({ q: 'x', 'output-file': '/tmp/a' })).toEqual({ q: 'x' });
    expect(coerceArgs(args, { q: 'x', 'output-file': '/tmp/a' })['output-file']).toBeUndefined();
    let missing: ActionError | undefined;
    try { coerceArgs(args, {}); } catch (e) { missing = e as ActionError; }
    expect(missing).toBeInstanceOf(ActionError);
    expect(missing?.code).toBe('invalid_args');
    expect(missing?.data).toMatchObject({ details: { expected: [{ name: 'q', required: true }, { name: 'limit', type: 'int', default: 5 }] } });
  });
});

describe('SourceLoader', () => {
  it('lists sites from the directory tree and resolves an adapter by path', async () => {
    const r = new SiteRegistry(defaultSources());
    await r.load();
    // twitter is a built-in adapter directory; the path is the identity
    expect(r.has('twitter')).toBe(true);
    expect(r.commandNames('twitter')).toEqual(expect.arrayContaining(['bookmarks', 'search']));
    const cmd = await r.resolve('twitter', 'bookmarks');
    expect(cmd.site).toBe('twitter');
    expect(cmd.access).toBe('read');
    expect(cmd.browser).toBe(true);
    expect(typeof cmd.run).toBe('function');
    expect(cmd.args.map((a) => a.name)).toContain('limit');
    // site.json defaults flow into the command
    expect(cmd.domain).toBe('x.com');
  });

  it('searches across the index and rejects an unknown command', async () => {
    const r = new SiteRegistry(defaultSources());
    await r.load();
    const hits = await r.search('twitter bookmarks');
    expect(hits[0]?.site).toBe('twitter');
    expect(hits[0]?.args).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'limit', type: 'int', default: 20 })]));
    await expect(r.resolve('twitter', 'nope')).rejects.toMatchObject({ code: 'unknown_command' });
  });
});
