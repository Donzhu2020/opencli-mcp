/** Where adapters live: the built-in corpus (ships with the package) and the user's writable, overriding source. */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Source } from '../sites/loader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repo/package root `/adapters` — from src/lib or dist/lib, `../../adapters`. */
export const BUILTIN_ADAPTERS_DIR = path.resolve(here, '../../adapters');
export const USER_ADAPTERS_DIR = path.join(os.homedir(), '.opencli-mcp', 'adapters');

/** Ordered sources; a later one overrides an earlier one for the same `<site>/<command>`. */
export function defaultSources(): Source[] {
  return [{ dir: BUILTIN_ADAPTERS_DIR, kind: 'builtin' }, { dir: USER_ADAPTERS_DIR, kind: 'user' }];
}
