import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  cloudAgentKey,
  cloudAgentPhase,
  type CloudControllerAgent,
  type CloudMachine,
  cloudMachineSchema,
  parseCloudAgentKey,
} from './cloud-agents';

const CORE_FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../../core/tests/switch_core/fixtures/hosted_machines'
);

function coreFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(CORE_FIXTURES, name), 'utf8')) as unknown;
}

const idleSleeping = coreFixture('machine_summary_sleeping.json');

const controller: CloudControllerAgent = {
  controllerId: 'cloud-controller',
  desiredState: 'running',
  process: 'running',
  detail: null,
};
const stoppedAgent: CloudControllerAgent = { ...controller, desiredState: 'stopped' };

function machine(overrides: Partial<CloudMachine>): CloudMachine {
  return {
    ...cloudMachineSchema.parse(idleSleeping),
    state: 'ready',
    desired_state: 'running',
    stop_reason: null,
    sleeping: false,
    ...overrides,
  };
}

it('parses the idle-sleeping machine summary Core serves', () => {
  expect(cloudMachineSchema.parse(idleSleeping)).toEqual(idleSleeping);
});

it('names a cloud agent by its server and managed agent', () => {
  const key = cloudAgentKey('server:1', 'agent_1');
  expect(parseCloudAgentKey(key)).toEqual({ serverId: 'server:1', agentId: 'agent_1' });
  expect(parseCloudAgentKey('cloud:server:00000000-0000-4000-8000-000000000001')).toBeNull();
  expect(parseCloudAgentKey('cloud:server:agent=')).toBeNull();
  expect(parseCloudAgentKey('local-agent')).toBeNull();
});

it('refuses a machine in a state it does not know', () => {
  expect(() =>
    cloudMachineSchema.parse({ ...(idleSleeping as object), state: 'hibernating' })
  ).toThrow();
});

it.each([
  ['an idle-sleeping machine', cloudMachineSchema.parse(idleSleeping), 'sleeping'],
  [
    'a machine its owner stopped',
    machine({ state: 'stopped', desired_state: 'stopped', stop_reason: 'owner' }),
    'machine_stopped',
  ],
  [
    'a machine in error',
    machine({ state: 'error', error: 'boom', error_code: 'machine_connect_timeout' }),
    'machine_error',
  ],
  ['a machine on its way up', machine({ state: 'provisioning' }), 'waking'],
  ['a retained machine being reused', machine({ state: 'retained' }), 'waking'],
  ['a ready machine', machine({}), null],
] as const)('reads %s', (_name, onMachine, phase) => {
  expect(cloudAgentPhase(onMachine, controller)).toBe(phase);
});

it('does not sleep or wake with its machine once its managed agent is stopped', () => {
  expect(cloudAgentPhase(cloudMachineSchema.parse(idleSleeping), stoppedAgent)).toBeNull();
  expect(cloudAgentPhase(machine({ state: 'provisioning' }), stoppedAgent)).toBeNull();
});

it('reads a machine its owner stopped whatever the agent', () => {
  expect(
    cloudAgentPhase(
      machine({ state: 'stopped', desired_state: 'stopped', stop_reason: 'owner' }),
      stoppedAgent
    )
  ).toBe('machine_stopped');
});

it('reads a machine in error whatever the agent', () => {
  expect(cloudAgentPhase(machine({ state: 'error' }), stoppedAgent)).toBe('machine_error');
});

it('reads a machine in error before its owner stopping it', () => {
  expect(
    cloudAgentPhase(
      machine({ state: 'error', desired_state: 'stopped', stop_reason: 'owner' }),
      controller
    )
  ).toBe('machine_error');
});

it('reads an agent whose machine is not listed as neither asleep nor waking', () => {
  expect(cloudAgentPhase(null, controller)).toBeNull();
});
