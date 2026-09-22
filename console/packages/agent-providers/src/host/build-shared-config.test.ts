import { describe, expect, it } from 'vitest';
import {
  buildSharedHostConfig,
  type BuildSharedHostConfigInput,
  type SharedHostProvider,
} from './build-shared-config';
import { sharedConfigSchema } from './shared-config';

const providerCapabilities: Array<
  [SharedHostProvider, BuildSharedHostConfigInput['capabilities']]
> = [
  ['claude', { approvals: true, userInput: true }],
  ['codex', { approvals: true, userInput: false }],
  ['opencode', { approvals: true, userInput: true }],
  ['antigravity', { approvals: true, userInput: true }],
  ['cursor', { approvals: true, userInput: false }],
];

function inputFor(
  provider: SharedHostProvider = 'codex',
  capabilities: BuildSharedHostConfigInput['capabilities'] = {
    approvals: true,
    userInput: false,
  }
): BuildSharedHostConfigInput {
  return {
    session: {
      sessionId: 'session-1',
      agentId: 'agent-1',
      provider,
      nativeSessionId: 'native-1',
    },
    launch: {
      cwd: '/workspace',
      runtimeMode: 'full-access',
      env: { CUSTOM_ENV: 'configured' },
      model: { id: 'selected-model', options: { effort: 'high' } },
    },
    capabilities,
    roomConnection: { rooms: ['room-1', 'room-2'], startCursor: 41 },
    execution: {
      credentialsPath: '/workspace/.switch/agents/agent.json',
      inheritEnv: ['PATH', 'HOME'],
      shellSetup: 'export CUSTOM_ENV=configured',
      binaryPath: '/tools/provider',
      mcpRuntime: '@sandboxaq/switch-agent-runtime@1.0.0',
      mcpRuntimePath: '/opt/switch/agent-providers/switch-agent-runtime.mjs',
      codexConfig: 'model = "selected-model"',
      skill: 'Switch skill',
      context: 'System context',
      agentDefinition: { name: 'agent-name', path: '.agents/agent-name.md' },
    },
    ids: {
      hostId: '00000000-0000-4000-8000-000000000001',
      epoch: '00000000-0000-4000-8000-000000000002',
      connectionId: '00000000-0000-4000-8000-000000000003',
    },
  };
}

describe('buildSharedHostConfig', () => {
  it.each(providerCapabilities)(
    'builds a schema-valid %s launch with its resolved capabilities',
    (provider, capabilities) => {
      const config = buildSharedHostConfig(inputFor(provider, capabilities));

      expect(sharedConfigSchema.parse(config)).toEqual(config);
      expect(config.session.provider).toBe(provider);
      expect(config.start.provider).toBe(provider);
      expect(config.session.capabilities).toEqual({
        input: 'queue',
        approvals: capabilities.approvals,
        questions: capabilities.userInput,
        interrupt: true,
        reset: true,
        compact: false,
        modelChange: false,
        attachmentMimeTypes: [],
      });
    }
  );

  it('preserves resolved resume, model, environment, room and execution inputs', () => {
    const config = buildSharedHostConfig(inputFor());

    expect(config.session).toMatchObject({
      sessionId: 'session-1',
      agentId: 'agent-1',
      hostId: '00000000-0000-4000-8000-000000000001',
      epoch: '00000000-0000-4000-8000-000000000002',
      status: 'starting',
      connectivity: 'online',
    });
    expect(config.start.input).toMatchObject({
      sessionId: 'session-1',
      cwd: '/workspace',
      runtimeMode: 'full-access',
      env: { CUSTOM_ENV: 'configured' },
      mcpServers: {},
      resume: { nativeSessionId: 'native-1' },
      model: { id: 'selected-model', options: { effort: 'high' } },
    });
    expect(config.roomConnection).toEqual({
      connectionId: '00000000-0000-4000-8000-000000000003',
      rooms: ['room-1', 'room-2'],
      startCursor: 41,
    });
    expect(config.execution).toEqual(inputFor().execution);
  });

  it('omits resume and model when the resolved launch does not request them', () => {
    const input = inputFor();
    delete input.session.nativeSessionId;
    delete input.launch.model;

    const config = buildSharedHostConfig(input);

    expect(config.start.input).not.toHaveProperty('resume');
    expect(config.start.input).not.toHaveProperty('model');
  });

  it('does not mutate inputs or retain their mutable nested values', () => {
    const input = inputFor();
    const before = structuredClone(input);
    const config = buildSharedHostConfig(input);

    expect(input).toEqual(before);
    config.start.input.env.CUSTOM_ENV = 'changed';
    config.start.input.model!.options!.effort = 'low';
    config.roomConnection!.rooms.push('room-3');
    config.execution!.inheritEnv.push('SHELL');
    config.execution!.agentDefinition!.name = 'changed';

    expect(input).toEqual(before);
  });
});
