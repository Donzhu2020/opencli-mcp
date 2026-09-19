import { describe, expect, it } from 'vitest';
import { argsToShape, coerceArgs, projectArgs, CLI_ONLY_ARGS, deCli } from '../src/sites/schema.js';
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

  it('strips CLI-only args from the agent-facing projection but keeps them for the executor', () => {
    const args = [
      { name: 'limit', type: 'int' }, { name: 'query', type: 'str' }, { name: 'page', type: 'int' }, { name: 'file', type: 'str' },
      { name: 'output', type: 'str' }, { name: 'output-file', type: 'str' }, { name: 'resume-file', type: 'str' }, { name: 'all', type: 'boolean' }, { name: 'timeout', type: 'int' },
    ];
    // projection (tool schema, search signatures, site resource): CLI-only args gone, data args (incl. upload `file`) kept
    const kept = projectArgs(args).map((a) => a.name);
    expect(kept).toEqual(['limit', 'query', 'page', 'file']);
    expect(Object.keys(argsToShape(args)).sort()).toEqual(['file', 'limit', 'page', 'query']);
    expect([...CLI_ONLY_ARGS]).toEqual(['output', 'output-file', 'resume-file', 'all', 'timeout', 'stdout']);
    // the executor still coerces them (js escape hatch / defaults) — projection hides, it does not delete behaviour
    expect(coerceArgs(args, { all: 'true', timeout: '30' })).toMatchObject({ all: true, timeout: 30 });
  });

  it('strips CLI --flag grammar from agent-facing text but leaves data words alone', () => {
    expect(deCli('Seconds the report must stay unchanged when --wait is true')).toBe('Seconds the report must stay unchanged when wait is true');
    expect(deCli('Conversation index within --project')).toBe('Conversation index within project');
    expect(deCli('pass --yes to actually delete')).toBe('pass yes to actually delete');
    expect(deCli('a range 10-20 and a-b hyphen')).toBe('a range 10-20 and a-b hyphen'); // single hyphens untouched
    expect(deCli(undefined)).toBe('');
    expect(CLI_ONLY_ARGS.has('stdout')).toBe(true);
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
