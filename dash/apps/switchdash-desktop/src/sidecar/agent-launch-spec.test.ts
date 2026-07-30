import { describe, expect, it } from 'vitest';
import { SWITCH_API_ENDPOINT_PLACEHOLDER } from '@shared/core/switch-rooms/switch-mcp-endpoint';
import {
  type AgentLaunchSpec,
  INITIAL_PROMPT_PLACEHOLDER,
  materializeAgentCommand,
  SESSION_ID_PLACEHOLDER,
} from './agent-launch-spec';

function spec(overrides: Partial<AgentLaunchSpec> = {}): AgentLaunchSpec {
  return {
    command: '/usr/bin/claude',
    args: [
      '--session-id',
      SESSION_ID_PLACEHOLDER,
      '--dangerously-skip-permissions',
      INITIAL_PROMPT_PLACEHOLDER,
    ],
    env: { BASE: '1' },
    cwd: '/home/agent/repo',
    providerId: 'claude',
    deeplinkScheme: 'switchdash',
    ...overrides,
  };
}

describe('materializeAgentCommand', () => {
  it('substitutes the session id and initial prompt tokens', () => {
    const cmd = materializeAgentCommand(spec(), {
      sessionId: 'session-9',
      initialPrompt: 'connect to switch room room-x',
      extraEnv: {},
      switchApiEndpoint: undefined,
    });
    expect(cmd.command).toBe('/usr/bin/claude');
    expect(cmd.args).toEqual([
      '--session-id',
      'session-9',
      '--dangerously-skip-permissions',
      'connect to switch room room-x',
    ]);
  });

  it('merges per-spawn env over the base env', () => {
    const cmd = materializeAgentCommand(spec({ env: { BASE: '1', SHARED: 'base' } }), {
      sessionId: 'c',
      initialPrompt: 'p',
      extraEnv: { SHARED: 'override', HOOK: 'x' },
      switchApiEndpoint: undefined,
    });
    expect(cmd.env).toEqual({ BASE: '1', SHARED: 'override', HOOK: 'x' });
  });

  it('launches a provider that takes no session id on a fresh session', () => {
    // Codex mints its own rollout id and only accepts one when resuming, so its
    // spec carries no session-id token. switchdash correlates the spawn through
    // the pty id in the hook env, not through argv.
    const cmd = materializeAgentCommand(spec({ args: ['-c', 'x', INITIAL_PROMPT_PLACEHOLDER] }), {
      sessionId: 'c',
      initialPrompt: 'connect to switch room room-x',
      extraEnv: {},
      switchApiEndpoint: undefined,
    });

    expect(cmd.args).toEqual(['-c', 'x', 'connect to switch room room-x']);
  });

  it('throws when the initial-prompt token is missing', () => {
    expect(() =>
      materializeAgentCommand(spec({ args: ['--session-id', SESSION_ID_PLACEHOLDER] }), {
        sessionId: 'c',
        initialPrompt: 'p',
        extraEnv: {},
        switchApiEndpoint: undefined,
      })
    ).toThrow(INITIAL_PROMPT_PLACEHOLDER);
  });
});

describe('materializeAgentCommand Switch endpoint substitution', () => {
  /** A Codex-shaped spec: the endpoint rides inside a larger `-c` argument. */
  function codexSpec(): AgentLaunchSpec {
    return spec({
      command: '/usr/bin/codex',
      providerId: 'codex',
      args: [
        'resume',
        SESSION_ID_PLACEHOLDER,
        '-c',
        `mcp_servers.switch.url="${SWITCH_API_ENDPOINT_PLACEHOLDER}/mcp/"`,
        '-c',
        'mcp_servers.switch.bearer_token_env_var="SWITCH_API_TOKEN"',
        INITIAL_PROMPT_PLACEHOLDER,
      ],
    });
  }

  it('substitutes the endpoint inside a larger argument, not as a whole token', () => {
    const cmd = materializeAgentCommand(codexSpec(), {
      sessionId: 's1',
      initialPrompt: 'p',
      extraEnv: {},
      switchApiEndpoint: 'https://switch.test/api',
    });

    expect(cmd.args).toContain('mcp_servers.switch.url="https://switch.test/api/mcp/"');
    expect(cmd.args.join(' ')).not.toContain(SWITCH_API_ENDPOINT_PLACEHOLDER);
  });

  it('normalises a trailing slash so the MCP path is not doubled', () => {
    const cmd = materializeAgentCommand(codexSpec(), {
      sessionId: 's1',
      initialPrompt: 'p',
      extraEnv: {},
      switchApiEndpoint: 'https://switch.test/api///',
    });

    expect(cmd.args).toContain('mcp_servers.switch.url="https://switch.test/api/mcp/"');
  });

  it('refuses to launch with an unsubstituted placeholder rather than pointing at literal text', () => {
    // A remote agent with no resolvable endpoint would otherwise come up with an
    // MCP server addressed as `__SWITCHDASH_SWITCH_API_ENDPOINT__/mcp/` and fail
    // on every tool call, looking configured the whole time.
    expect(() =>
      materializeAgentCommand(codexSpec(), {
        sessionId: 's1',
        initialPrompt: 'p',
        extraEnv: {},
        switchApiEndpoint: undefined,
      })
    ).toThrow(/unsubstituted placeholder/);
  });

  it('leaves a spec with no endpoint token alone', () => {
    const cmd = materializeAgentCommand(spec(), {
      sessionId: 's1',
      initialPrompt: 'p',
      extraEnv: {},
      switchApiEndpoint: 'https://switch.test/api',
    });

    expect(cmd.args).toEqual(['--session-id', 's1', '--dangerously-skip-permissions', 'p']);
  });
});
