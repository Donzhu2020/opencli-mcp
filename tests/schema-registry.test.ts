import { describe, expect, it } from 'vitest';
import { argsToShape, coerceArgs, type Arg } from '../src/sites/schema.js';
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
    expect(() => coerceArgs(args, {})).toThrow(/required/);
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
    await expect(r.resolve('twitter', 'nope')).rejects.toMatchObject({ code: 'unknown_command' });
  });
});
