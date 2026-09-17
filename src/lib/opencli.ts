/**
 * Access to the OpenCLI library (installed as a dependency): its public exports for the
 * adapter contract, plus internal modules reached by file URL (the package `exports` map
 * only gates bare specifiers).
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

// `exports` hides package.json; resolve a public subpath (dist/src/registry-api.js) and walk up.
export const opencliDist: string = path.dirname(require.resolve('@jackwener/opencli/registry'));
export const opencliRoot: string = path.resolve(opencliDist, '..', '..');
export const opencliClisDir: string = path.join(opencliRoot, 'clis');
export const opencliManifestPath: string = path.join(opencliRoot, 'cli-manifest.json');
export const opencliVersion: string = (JSON.parse(fs.readFileSync(path.join(opencliRoot, 'package.json'), 'utf8')) as { version: string }).version;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function importDist(relative: string): Promise<any> {
  return import(pathToFileURL(path.join(opencliDist, relative)).href);
}
