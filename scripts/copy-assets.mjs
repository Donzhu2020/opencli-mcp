import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DOCS_MANIFEST } from '../dist/src/docs/manifest.js';

const root = resolve(import.meta.dirname, '..');
for (const name of ['js-worker.mjs', 'js-evaluator.mjs']) copyFileSync(resolve(root, 'src/mcp', name), resolve(root, 'dist/src/mcp', name));
rmSync(resolve(root, 'dist/docs'), { recursive: true, force: true });
for (const { name } of DOCS_MANIFEST) {
  const target = resolve(root, 'dist/docs', `${name}.md`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(root, 'docs', `${name}.md`), target);
}
console.log(`copied ${DOCS_MANIFEST.length} runtime docs`);
