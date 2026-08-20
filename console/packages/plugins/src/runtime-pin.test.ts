import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SWITCH_AGENT_RUNTIME_PIN } from './distribution';

// packages/plugins/src → repo root
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const BUNDLED_MCP_CONFIGS = [
  'connectors/claude-code-plugin/.mcp.json',
  'connectors/codex-plugin/.mcp.json',
];

function pinnedRuntimeIn(relativePath: string): string {
  const raw = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
  const config = JSON.parse(raw) as {
    mcpServers?: Record<string, { args?: string[] }>;
  };
  const args = config.mcpServers?.switch?.args ?? [];
  const pin = args.find((arg) => arg.includes('switch-agent-runtime'));
  if (!pin) throw new Error(`${relativePath} pins no agent runtime`);
  return pin;
}

/**
 * The two marketplace connectors pin the runtime in their own `.mcp.json`, and
 * an agent with no marketplace gets the pin from `distribution.ts` instead.
 * Nothing forces those to agree, and disagreement is invisible: each host just
 * runs whatever its own file says, so one agent type silently runs a different
 * protocol client from the others.
 */
describe('agent runtime pin', () => {
  it.each(BUNDLED_MCP_CONFIGS)('matches the pin bundled in %s', (relativePath) => {
    expect(pinnedRuntimeIn(relativePath)).toBe(SWITCH_AGENT_RUNTIME_PIN);
  });

  it('names an exact published version', () => {
    // A floating range would make two sessions started minutes apart run
    // different runtimes, which is untraceable after the fact.
    expect(SWITCH_AGENT_RUNTIME_PIN).toMatch(/^@sandboxaq\/switch-agent-runtime@\d+\.\d+\.\d+$/);
  });
});
