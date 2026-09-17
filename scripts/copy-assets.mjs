import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
mkdirSync(resolve(root, 'dist'), { recursive: true });
cpSync(resolve(root, 'docs'), resolve(root, 'dist/docs'), { recursive: true });
console.log('assets copied');
