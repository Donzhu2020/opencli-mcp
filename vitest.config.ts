import { defineConfig } from 'vitest/config';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// tests that define tools write to a throwaway directory, never to ~/.opencli-mcp/tools
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], testTimeout: 30000, env: { OPENCLI_MCP_TOOLS_DIR: mkdtempSync(join(tmpdir(), 'opencli-mcp-tools-')) } } });
