import { describe, expect, it } from 'vitest';
import { buildSharedHostConfig, type BuildSharedHostConfigInput } from './build-shared-config';

describe('buildSharedHostConfig', () => {
  const baseInput: BuildSharedHostConfigInput = {
    session: {
      sessionId: 'sess-1',
      agentId: 'agent-1',
      provider: 'claude',
    },
    launch: {
      cwd: '/test/workspace',
      runtimeMode: 'approval-required',
      env: {},
      model: undefined,
    },
    capabilities: {
      approvals: true,
      userInput: true,
      steering: true,
    },
    execution: {
      credentialsPath: '/tmp/cred',
      inheritEnv: [],
      binaryPath: 'claude',
      codexConfig: '',
      skill: '',
      context: '',
      agentDefinition: undefined,
    },
    ids: {
      hostId: 'host-1',
      epoch: 'epoch-1',
      connectionId: 'conn-1',
    },
  };

  it('advertises input as steer when provider supports steering', () => {
    const config = buildSharedHostConfig({
      ...baseInput,
      capabilities: { ...baseInput.capabilities, steering: true },
    });
    expect(config.session.capabilities.input).toBe('steer');
  });

  it('advertises input as queue when provider does not support steering', () => {
    const config = buildSharedHostConfig({
      ...baseInput,
      capabilities: { ...baseInput.capabilities, steering: false },
    });
    expect(config.session.capabilities.input).toBe('queue');
  });
});
