import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NPM_TOKEN_VAR } from '@shared/core/npm-registry';
import {
  SWITCH_AGENT_RUNTIME_PACKAGE,
  SWITCH_AGENT_RUNTIME_VERSION,
  SWITCH_RUNTIME_ENV_VARS,
  SWITCH_RUNTIME_OPTIONAL_ENV,
  SWITCH_RUNTIME_REQUIRED_ENV,
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

/** The `switch` server entry from the Claude connector's bundled .mcp.json. */
function claudeSwitchServer(): { args?: string[]; env?: Record<string, string> } {
  const mcp = JSON.parse(readFileSync(findClaudeMcpJson(), 'utf8')) as {
    mcpServers: Record<string, { args?: string[]; env?: Record<string, string> }>;
  };
  return mcp.mcpServers.switch ?? {};
}

/** The runtime package's own version, the third pin nothing else checks. */
function runtimePackageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'dash/packages/switch-agent-runtime/package.json');
    if (existsSync(candidate)) {
      return (JSON.parse(readFileSync(candidate, 'utf8')) as { version: string }).version;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate packages/switch-agent-runtime/package.json');
}

describe('switchAgentRuntimeCommand', () => {
  it('resolves npx against the pinned package version', () => {
    const { command, args } = switchAgentRuntimeCommand();
    expect(command).toBe('npx');
    expect(args).toEqual(['-y', `${SWITCH_AGENT_RUNTIME_PACKAGE}@${SWITCH_AGENT_RUNTIME_VERSION}`]);
  });

  it('forwards what npx itself needs to reach the private registry', () => {
    // Without these the child cannot fetch the package at all on a cold cache,
    // and the failure reads as a 404 for something that does not exist.
    expect(switchAgentRuntimeCommand().envVars).toEqual(
      expect.arrayContaining(['npm_config_userconfig', NPM_TOKEN_VAR])
    );
  });

  it('stays pinned to the same runtime version the Claude connector .mcp.json registers', () => {
    // Codex registers this runtime via a profile and Claude via its bundled
    // .mcp.json. Both must run the same published version; this guards the two
    // pins from drifting when only one is bumped.
    const args = claudeSwitchServer().args ?? [];
    expect(args).toContain(`${SWITCH_AGENT_RUNTIME_PACKAGE}@${SWITCH_AGENT_RUNTIME_VERSION}`);
  });

  it('never pins a version ahead of the one the package declares', () => {
    // The third pin AGENTS.md names. Not an equality: the package version may
    // run ahead while a release is prepared, and the pin must keep naming a
    // published version until then — pinning ahead points every session at
    // something the registry does not have. Behind is staged; ahead is broken.
    const pinned = SWITCH_AGENT_RUNTIME_VERSION.split('.').map(Number);
    const declared = runtimePackageVersion().split('.').map(Number);
    expect(pinned.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      if (pinned[i]! !== declared[i]!) {
        expect(pinned[i]!).toBeLessThan(declared[i]!);
        return;
      }
    }
  });
});

describe('the credentials the runtime needs', () => {
  it('are declared identically by the Claude connector and this module', () => {
    // Both hosts must route the same required credentials; neither side may add
    // one without the other, or that host's sessions start without it.
    const declared = Object.keys(claudeSwitchServer().env ?? {}).sort();
    expect(declared).toEqual([...SWITCH_RUNTIME_REQUIRED_ENV].sort());
  });

  it('are expanded by the Claude connector under their own names', () => {
    // Catches a transposed pair — ${SWITCH_API_TOKEN} filed under
    // SWITCH_API_ENDPOINT — which no other assertion here would see.
    for (const [name, value] of Object.entries(claudeSwitchServer().env ?? {})) {
      expect(value).toBe(`\${${name}}`);
    }
  });

  it('keep the optional ones out of the Claude connector, where declaring is requiring', () => {
    // Claude expands ${VAR} and fails the whole server when one resolves to
    // nothing, so an optional variable declared there costs every standalone
    // session its tools. Codex forwards names, so an unset one is just skipped.
    const declared = Object.keys(claudeSwitchServer().env ?? {});
    for (const name of SWITCH_RUNTIME_OPTIONAL_ENV) {
      expect(declared).not.toContain(name);
    }
  });

  it('are all routed by the Codex launch command', () => {
    expect(switchAgentRuntimeCommand().envVars).toEqual([...SWITCH_RUNTIME_ENV_VARS]);
  });
});
