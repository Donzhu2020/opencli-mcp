import { describe, expect, it } from 'vitest';
import { argsToShape, coerceArgs } from '../src/sites/schema.js';
import { SiteRegistry } from '../src/sites/registry.js';
import { z } from 'zod';

describe('schema', () => {
  it('maps OpenCLI args to zod and coerces', () => {
    const args = [{ name: 'limit', type: 'int', default: 20, help: 'n' }, { name: 'q', required: true }, { name: 'sort', choices: ['hot', 'new'] }, { name: 'all', type: 'boolean' }];
    const shape = z.object(argsToShape(args));
    expect(shape.parse({ q: 'x', limit: 3 })).toEqual({ q: 'x', limit: 3 });
    expect(() => shape.parse({ limit: 3 })).toThrow();
    expect(coerceArgs(args, { q: 'x', limit: '5', all: 'true', sort: 'hot' })).toEqual({ q: 'x', limit: 5, all: true, sort: 'hot' });
    expect(() => coerceArgs(args, { q: 'x', sort: 'weird' })).toThrow(/one of/);
  });
});

describe('site registry', () => {
  it('loads the OpenCLI corpus and resolves a public command', async () => {
    const r = new SiteRegistry();
    await r.load();
    expect(r.sites().length).toBeGreaterThan(100);
    expect(r.all().length).toBeGreaterThan(1000);
    const hits = r.search('hackernews top');
    expect(hits[0].site).toBe('hackernews');
    const cmd = await r.resolve('hackernews', 'top');
    expect(cmd.browser).toBe(false);
    expect(cmd.pipeline || cmd.func).toBeTruthy();
    expect((cmd as { source?: string }).source).toBe('builtin');
  });
  it('a tool defined now resolves as source "defined" at once (no restart), and as builtin once removed', async () => {
    // OpenCLI's cli() copies a fixed field list, so the registry's own record is the only carrier of the mark
    const r = new SiteRegistry();
    await r.load();
    const def = { site: 'hackernews', name: 'zz-probe', description: 'probe', access: 'read' as const, args: [], func: 'async ({ tab, args }) => ({ ok: true })' };
    try {
      await r.define(def);
      expect((await r.resolve('hackernews', 'zz-probe') as { source?: string }).source).toBe('defined');
      expect((await r.resolve('hackernews', 'top') as { source?: string }).source).toBe('builtin'); // siblings untouched
    } finally { r.remove('hackernews', 'zz-probe'); }
    await expect(r.resolve('hackernews', 'zz-probe')).rejects.toMatchObject({ code: 'unknown_command' });
  });
});
