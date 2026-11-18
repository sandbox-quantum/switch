import { describe, expect, it } from 'vitest';
import { buildSharedHostConfig, type BuildSharedHostConfigInput } from './build-shared-config';

const input = (steering: boolean): BuildSharedHostConfigInput => ({
  session: { sessionId: 'session-1', agentId: 'agent-1', provider: 'claude' },
  launch: { cwd: '/work', runtimeMode: 'approval-required', env: {}, model: undefined },
  capabilities: { approvals: true, userInput: true, steering },
  execution: {
    credentialsPath: '/data/credentials.json',
    inheritEnv: [],
    binaryPath: '/usr/bin/claude',
    codexConfig: '',
    skill: '',
    context: '',
    agentDefinition: undefined,
  },
  ids: { hostId: 'host', epoch: 'epoch', connectionId: 'connection' },
});

describe('buildSharedHostConfig', () => {
  it('advertises steering for a provider that can take a message mid-turn', () => {
    expect(buildSharedHostConfig(input(true)).session.capabilities.input).toBe('steer');
  });

  it('advertises queueing for a provider that cannot', () => {
    expect(buildSharedHostConfig(input(false)).session.capabilities.input).toBe('queue');
  });
});
