import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SWITCH_RUNTIME_ENV_VARS,
  SWITCH_RUNTIME_OPTIONAL_ENV,
  SWITCH_RUNTIME_REQUIRED_ENV,
} from './switch-agent-runtime';

const CLAUDE_MCP_JSON = 'connectors/claude-code-plugin/.mcp.json';
const CODEX_MCP_JSON = 'connectors/codex-plugin/.mcp.json';

type SwitchServerEntry = {
  args?: string[];
  env?: Record<string, string>;
  env_vars?: string[];
  default_tools_approval_mode?: string;
};

/** Walk up from this file until the given repo-relative path is found. */
function findRepoFile(relative: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate ${relative} above ${fileURLToPath(import.meta.url)}`);
}

/** The `switch` server entry from a connector plugin's bundled .mcp.json. */
function switchServerIn(relative: string): SwitchServerEntry {
  const mcp = JSON.parse(readFileSync(findRepoFile(relative), 'utf8')) as {
    mcpServers: Record<string, SwitchServerEntry>;
  };
  return mcp.mcpServers.switch ?? {};
}

const claudeSwitchServer = (): SwitchServerEntry => switchServerIn(CLAUDE_MCP_JSON);
const codexSwitchServer = (): SwitchServerEntry => switchServerIn(CODEX_MCP_JSON);

describe('the credentials the runtime needs', () => {
  it('are declared by the Claude connector not at all, so a standalone session can start', () => {
    // Claude expands ${VAR} and fails the WHOLE server when one resolves to
    // nothing. Declaring a credential there therefore makes it mandatory — and
    // since CHOO-1962 the runtime can resolve its own from the on-disk store,
    // so declaring them would break precisely the case the store exists for.
    // switchdash's own sessions are unaffected: it sets real env vars, which
    // reach the MCP child whether or not the config mentions them.
    expect(claudeSwitchServer().env).toBeUndefined();
  });

  it('keep every optional one out of the Claude connector too, for the same reason', () => {
    const declared = Object.keys(claudeSwitchServer().env ?? {});
    for (const name of [...SWITCH_RUNTIME_OPTIONAL_ENV, ...SWITCH_RUNTIME_REQUIRED_ENV]) {
      expect(declared).not.toContain(name);
    }
  });

  it('are all named by the Codex connector, which forwards by name', () => {
    // Codex passes an MCP child a fixed allowlist and nothing else, so a name
    // missing here reaches the runtime as nothing at all — and a missing
    // credential kills the handshake rather than one tool. Safe to list the
    // optional tier too: an unset name is simply not forwarded.
    expect(codexSwitchServer().env_vars).toEqual([...SWITCH_RUNTIME_ENV_VARS]);
  });

  it('are named by the Codex connector without any value channel', () => {
    const server = codexSwitchServer();
    expect(server.env).toBeUndefined();
    for (const name of server.env_vars ?? []) {
      expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });
});

describe('the Codex connector tool approval', () => {
  it('auto-approves the Switch tools, which no approval_policy would have done', () => {
    // An agent answering a room is unattended: a prompt on `post_message` stops
    // the turn with nobody to release it. Measured against codex-cli 0.146.0,
    // `approval_policy` does not govern MCP tool calls at all — a write-annotated
    // tool is denied under `never` just as under `untrusted` — so the bypass
    // toggle cannot cover this and only this field can.
    expect(codexSwitchServer().default_tools_approval_mode).toBe('approve');
  });

  it('stays inside the enum Codex accepts, which it does not police', () => {
    // An unrecognised value does not fail loudly: Codex drops the whole server
    // and reports no MCP servers at all, so the session simply has no Switch
    // tools. `approve` is also the only one of the four that admits a tool
    // annotated as writing, which most Switch tools are.
    expect(['auto', 'prompt', 'writes', 'approve']).toContain(
      codexSwitchServer().default_tools_approval_mode
    );
  });
});
