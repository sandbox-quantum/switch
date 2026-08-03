import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SWITCH_AGENT_RUNTIME_PACKAGE,
  SWITCH_AGENT_RUNTIME_VERSION,
  switchAgentRuntimeCommand,
} from './switch-agent-runtime';

const MCP_JSON_RELATIVE = 'connectors/claude-code-plugin/.mcp.json';

/** Walk up from this file until the connector plugin's .mcp.json is found. */
function findClaudeMcpJson(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, MCP_JSON_RELATIVE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate ${MCP_JSON_RELATIVE} above ${fileURLToPath(import.meta.url)}`);
}

describe('switchAgentRuntimeCommand', () => {
  it('resolves npx against the pinned package version', () => {
    expect(switchAgentRuntimeCommand()).toEqual({
      command: 'npx',
      args: ['-y', `${SWITCH_AGENT_RUNTIME_PACKAGE}@${SWITCH_AGENT_RUNTIME_VERSION}`],
    });
  });

  it('stays pinned to the same runtime version the Claude connector .mcp.json registers', () => {
    // Codex registers this runtime via a profile and Claude via its bundled
    // .mcp.json. Both must run the same published version; this guards the two
    // pins from drifting when only one is bumped.
    const mcp = JSON.parse(readFileSync(findClaudeMcpJson(), 'utf8')) as {
      mcpServers: Record<string, { command?: string; args?: string[] }>;
    };
    const args = mcp.mcpServers.switch?.args ?? [];
    expect(args).toContain(`${SWITCH_AGENT_RUNTIME_PACKAGE}@${SWITCH_AGENT_RUNTIME_VERSION}`);
  });
});
