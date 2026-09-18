import { defineConfig } from 'vitest/config';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// tests run against a throwaway home: nothing they define or write touches ~/.opencli-mcp
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], testTimeout: 30000, env: { HOME: mkdtempSync(join(tmpdir(), 'opencli-mcp-home-')) } } });
