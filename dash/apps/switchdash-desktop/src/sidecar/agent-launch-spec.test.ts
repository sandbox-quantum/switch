import { describe, expect, it } from 'vitest';
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
    });
    expect(cmd.env).toEqual({ BASE: '1', SHARED: 'override', HOOK: 'x' });
  });

  it('throws when the session-id token is missing', () => {
    expect(() =>
      materializeAgentCommand(spec({ args: [INITIAL_PROMPT_PLACEHOLDER] }), {
        sessionId: 'c',
        initialPrompt: 'p',
        extraEnv: {},
      })
    ).toThrow(SESSION_ID_PLACEHOLDER);
  });

  it('throws when the initial-prompt token is missing', () => {
    expect(() =>
      materializeAgentCommand(spec({ args: ['--session-id', SESSION_ID_PLACEHOLDER] }), {
        sessionId: 'c',
        initialPrompt: 'p',
        extraEnv: {},
      })
    ).toThrow(INITIAL_PROMPT_PLACEHOLDER);
  });
});
