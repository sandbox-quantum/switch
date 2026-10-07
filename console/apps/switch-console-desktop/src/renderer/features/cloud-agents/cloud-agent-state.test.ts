import { describe, expect, it } from 'vitest';
import type { CloudAgent, CloudMachine } from '@shared/core/cloud-agents/cloud-agents';
import { cloudAgentState, cloudHoldBlocker } from './cloud-agent-state';

function machine(overrides: Partial<CloudMachine>): CloudMachine {
  return {
    machine_id: '3f1c2b4a-0000-4000-8000-000000000001',
    state: 'ready',
    desired_state: 'running',
    stop_reason: null,
    sleeping: false,
    revision: 4,
    instance_type: null,
    error: null,
    error_code: null,
    retain_until: null,
    heartbeat_at: null,
    controller_id: null,
    disk: null,
    memory: null,
    agents: [],
    ...overrides,
  };
}

function agent(
  controller: Partial<CloudAgent['controller']> = {},
  onMachine: CloudMachine | null = machine({})
): CloudAgent {
  return {
    key: 'cloud:server:agent=agent',
    agentId: 'agent',
    name: 'reviewer',
    provider: 'claude',
    machine: onMachine,
    controller: {
      controllerId: 'cloud-controller',
      desiredState: 'running',
      process: 'running',
      detail: null,
      ...controller,
    },
    sessions: null,
    problem: null,
  };
}

describe('a cloud agent on a machine in error', () => {
  it('reads as a machine error, not as ready', () => {
    expect(cloudAgentState(agent({}, machine({ state: 'error' })))).toEqual({
      label: 'machine error',
      tone: 'bad',
    });
  });
});

describe('a cloud agent on its way up', () => {
  it('reads as waking while its machine starts', () => {
    expect(cloudAgentState(agent({}, machine({ state: 'provisioning' })))).toEqual({
      label: 'waking…',
      tone: 'busy',
    });
  });

  it('reads as ready on a ready machine', () => {
    expect(cloudAgentState(agent({}))).toBeNull();
  });
});

describe('a cloud agent its controller reports', () => {
  it('reads its managed agent stopped or crashed', () => {
    expect(cloudAgentState(agent({ desiredState: 'stopped' }))).toEqual({
      label: 'stopped',
      tone: 'idle',
    });
    expect(cloudAgentState(agent({ process: 'crashed' }))).toEqual({
      label: 'crashed',
      tone: 'bad',
    });
  });

  it('reads as unreachable when it cannot be asked for its own reason', () => {
    expect(
      cloudAgentState({
        ...agent({}),
        problem: { code: 'relay_timeout', message: 'timed out', wakeAvailable: false },
      })
    ).toEqual({ label: 'unreachable', tone: 'bad' });
  });
});

describe('why a held message will not be delivered', () => {
  it.each([
    [
      'a sleeping machine',
      agent(
        {},
        machine({ desired_state: 'stopped', stop_reason: 'idle', sleeping: true, state: 'stopped' })
      ),
    ],
    ['a machine on its way up', agent({}, machine({ state: 'provisioning' }))],
    ['a ready machine', agent({})],
  ])('is nothing on %s', (_name, onAgent) => {
    expect(cloudHoldBlocker(onAgent)).toBeNull();
  });

  it.each([
    [
      'the owner stopped the machine',
      agent({}, machine({ desired_state: 'stopped', stop_reason: 'owner', state: 'stopped' })),
      'The owner stopped the cloud machine.',
    ],
    [
      'the machine is in error',
      agent({}, machine({ state: 'error' })),
      'The cloud machine is in error.',
    ],
    [
      'the machine needs attention',
      agent({}, machine({ state: 'error', error_code: 'machine_needs_attention' })),
      'Contact your server administrator.',
    ],
    [
      'the agent was stopped elsewhere',
      agent({ desiredState: 'stopped' }, machine({ state: 'provisioning' })),
      'This agent is stopped.',
    ],
    ['the agent crashed', agent({ process: 'crashed' }), 'This agent crashed.'],
    ['the agent failed', agent({ process: 'failed' }), 'This agent crashed.'],
  ])('says so when %s', (_name, onAgent, text) => {
    expect(cloudHoldBlocker(onAgent)).toContain(text);
  });
});
