import { LAUNCH_PROFILE_HOME_PLACEHOLDER } from '@switch-console/core/agents/plugins';
import { describe, expect, it } from 'vitest';
import {
  type AgentLaunchSpec,
  HOME_PLACEHOLDER,
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
    autoApprove: false,
    autoTrustWorktrees: true,
    ...overrides,
  };
}

describe('materializeAgentCommand', () => {
  it('substitutes the session id and initial prompt tokens', () => {
    const cmd = materializeAgentCommand(spec(), {
      sessionId: 'session-9',
      initialPrompt: 'connect to switch room room-x',
      extraEnv: {},
      homeDir: '/home/agent',
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
      homeDir: '/home/agent',
    });
    expect(cmd.env).toEqual({ BASE: '1', SHARED: 'override', HOOK: 'x' });
  });

  it('launches a provider that takes no session id on a fresh session', () => {
    // Codex mints its own rollout id and only accepts one when resuming, so its
    // spec carries no session-id token. Switch Console correlates the spawn through
    // the pty id in the hook env, not through argv. The Switch MCP server rides a
    // baked profile (launchFiles) and env, not argv, so nothing to substitute.
    const cmd = materializeAgentCommand(
      spec({ args: ['--profile', 'codex-hoot', INITIAL_PROMPT_PLACEHOLDER] }),
      {
        sessionId: 'c',
        initialPrompt: 'connect to switch room room-x',
        extraEnv: {},
        homeDir: '/home/agent',
      }
    );

    expect(cmd.args).toEqual(['--profile', 'codex-hoot', 'connect to switch room room-x']);
  });

  it('throws when the initial-prompt token is missing', () => {
    expect(() =>
      materializeAgentCommand(spec({ args: ['--session-id', SESSION_ID_PLACEHOLDER] }), {
        sessionId: 'c',
        initialPrompt: 'p',
        extraEnv: {},
        homeDir: '/home/agent',
      })
    ).toThrow(INITIAL_PROMPT_PLACEHOLDER);
  });

  it('refuses to launch with an unsubstituted placeholder rather than pointing at literal text', () => {
    expect(() =>
      materializeAgentCommand(
        spec({ args: ['--session-id', '__SWITCHDASH_ROGUE__', INITIAL_PROMPT_PLACEHOLDER] }),
        {
          sessionId: 's1',
          initialPrompt: 'p',
          extraEnv: {},
          homeDir: '/home/agent',
        }
      )
    ).toThrow(/unsubstituted placeholder/);
  });
});

describe('HOME_PLACEHOLDER', () => {
  it('is the same token the plugin packages emit', () => {
    // The sidecar is a standalone bundle and deliberately imports nothing from
    // the plugin packages, so the token it substitutes is a second declaration
    // of the one plugins write. If they drift, a remote OpenCode session gets a
    // config path that was never completed.
    expect(HOME_PLACEHOLDER).toBe(LAUNCH_PROFILE_HOME_PLACEHOLDER);
  });

  it('resolves a profile env value naming a baked launch file', () => {
    const cmd = materializeAgentCommand(
      spec({ env: { OPENCODE_CONFIG: `${HOME_PLACEHOLDER}/.config/opencode/switch/a.json` } }),
      {
        sessionId: 's',
        initialPrompt: 'p',
        extraEnv: {},
        homeDir: '/home/agent',
      }
    );

    expect(cmd.env.OPENCODE_CONFIG).toBe('/home/agent/.config/opencode/switch/a.json');
  });

  it('fails the spawn rather than passing an unsubstituted placeholder to the agent', () => {
    expect(() =>
      materializeAgentCommand(spec({ env: { SOMETHING: '__SWITCHDASH_UNKNOWN__/x' } }), {
        sessionId: 's',
        initialPrompt: 'p',
        extraEnv: {},
        homeDir: '/home/agent',
      })
    ).toThrow(/unsubstituted placeholder in env SOMETHING/);
  });
});
