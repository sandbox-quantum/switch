import { pluginRegistry } from '@switch-console/plugins/agents';
import { describe, expect, it } from 'vitest';
import type { Session } from '@shared/core/sessions/sessions';
import { resolveAgentSessionCommandArgs } from './resolve-agent-session-command';

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = '2024-01-01T00:00:00.000Z';
  return {
    id: 'session-1',
    agentId: 'agent-1',
    providerId: 'droid',
    title: 'Test',
    shellId: 'system',
    status: 'in_progress',
    statusChangedAt: now,
    agentSessionId: null,
    isInitialSession: false,
    isPinned: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('resolveAgentSessionCommandArgs', () => {
  it('uses stored Codex session id when resuming', () => {
    expect(
      resolveAgentSessionCommandArgs(
        makeSession({
          providerId: 'codex',
          providerSessionId: '019c95f6-cd96-7812-ba15-574286674599',
        }),
        true
      )
    ).toEqual({ sessionId: '019c95f6-cd96-7812-ba15-574286674599', isResuming: true });
  });

  it('starts fresh instead of resuming Codex --last without a stored session id', () => {
    expect(resolveAgentSessionCommandArgs(makeSession({ providerId: 'codex' }), true)).toEqual({
      sessionId: 'session-1',
      isResuming: false,
    });
  });

  it('uses stored Droid session id when resuming', () => {
    expect(
      resolveAgentSessionCommandArgs(
        makeSession({ providerSessionId: '31477a03-961a-4451-82d4-efded56947fc' }),
        true
      )
    ).toEqual({ sessionId: '31477a03-961a-4451-82d4-efded56947fc', isResuming: true });
  });

  it('starts fresh when resuming Droid without a stored session id', () => {
    expect(resolveAgentSessionCommandArgs(makeSession(), true)).toEqual({
      sessionId: 'session-1',
      isResuming: false,
    });
  });

  it('keeps resume enabled when provider session ids are unavailable', () => {
    expect(
      resolveAgentSessionCommandArgs(makeSession(), true, { requireProviderSessionId: false })
    ).toEqual({
      sessionId: 'session-1',
      isResuming: true,
    });
  });

  it('passes through for non-Droid providers', () => {
    expect(
      resolveAgentSessionCommandArgs(
        makeSession({
          providerId: 'claude',
          providerSessionId: '31477a03-961a-4451-82d4-efded56947fc',
        }),
        true
      )
    ).toEqual({ sessionId: 'session-1', isResuming: true });
  });

  it('builds a Claude replacement resume command from the logical session id', () => {
    const session = makeSession({
      id: '6fac6620-9fa8-4604-b7e0-1fe361589104',
      providerId: 'claude',
    });
    const spawnPlan = resolveAgentSessionCommandArgs(session, true);
    const result = pluginRegistry.get('claude')!.behavior.prompt!.buildCommand({
      cli: 'claude',
      autoApprove: false,
      model: '',
      sessionId: spawnPlan.sessionId,
      isResuming: spawnPlan.isResuming,
    });

    expect(result.command).toBe('claude');
    expect(result.args).toContain('--resume');
    expect(result.args).toContain(session.id);
  });

  it('uses the stored OpenCode session id when resuming', () => {
    expect(
      resolveAgentSessionCommandArgs(
        makeSession({ providerId: 'opencode', providerSessionId: 'ses_abc123' }),
        true
      )
    ).toEqual({ sessionId: 'ses_abc123', isResuming: true });
  });

  // Without this, resume falls through to OpenCode's `--continue`, which
  // reattaches to whatever ran last in that directory — for a Switch agent,
  // very possibly a conversation belonging to someone else.
  it('starts fresh instead of continuing the last OpenCode session', () => {
    expect(resolveAgentSessionCommandArgs(makeSession({ providerId: 'opencode' }), true)).toEqual({
      sessionId: 'session-1',
      isResuming: false,
    });
  });

  it('builds an OpenCode resume command from the stored provider session id', () => {
    const session = makeSession({
      id: '6fac6620-9fa8-4604-b7e0-1fe361589104',
      providerId: 'opencode',
      providerSessionId: 'ses_abc123',
    });
    const spawnPlan = resolveAgentSessionCommandArgs(session, true);
    const result = pluginRegistry.get('opencode')!.behavior.prompt!.buildCommand({
      cli: 'opencode',
      autoApprove: false,
      model: '',
      sessionId: spawnPlan.sessionId,
      providerSessionId: session.providerSessionId ?? undefined,
      isResuming: spawnPlan.isResuming,
    });

    expect(result.command).toBe('opencode');
    expect(result.args).toEqual(['--session', 'ses_abc123']);
  });

  it('builds a Codex replacement resume command from the stored provider session id', () => {
    const session = makeSession({
      id: '6fac6620-9fa8-4604-b7e0-1fe361589104',
      providerId: 'codex',
      providerSessionId: 'provider-session-1',
    });
    const spawnPlan = resolveAgentSessionCommandArgs(session, true);
    const result = pluginRegistry.get('codex')!.behavior.prompt!.buildCommand({
      cli: 'codex',
      autoApprove: false,
      model: '',
      sessionId: spawnPlan.sessionId,
      providerSessionId: session.providerSessionId ?? undefined,
      isResuming: spawnPlan.isResuming,
    });

    expect(result.command).toBe('codex');
    // Hook trust leads every Codex invocation, before the subcommand.
    expect(result.args).toEqual([
      '--dangerously-bypass-hook-trust',
      'resume',
      'provider-session-1',
    ]);
  });
});
