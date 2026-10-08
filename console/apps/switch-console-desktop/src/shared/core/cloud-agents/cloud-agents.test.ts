import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  cloudAgentPhase,
  type CloudLaunch,
  cloudLaunchSchema,
  type CloudMachine,
  cloudMachineSchema,
} from './cloud-agents';

const CORE_FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../../core/tests/switch_core/fixtures/hosted_machines'
);

function coreFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(CORE_FIXTURES, name), 'utf8')) as unknown;
}

const idleSleeping = coreFixture('machine_summary_sleeping.json');

const launch: CloudLaunch = cloudLaunchSchema.parse({
  request_id: '00000000-0000-4000-8000-000000000001',
  name: 'reviewer',
  provider: 'claude',
  state: 'ready',
  desired_state: 'running',
  revision: 3,
  agent_id: '3f1c2b4a-0000-4000-8000-0000000000a1',
  error: null,
  error_code: null,
  sleeping: false,
  machine_id: '3f1c2b4a-0000-4000-8000-000000000001',
  process_state: 'running',
  process_restarts: 0,
  oom_kills: 0,
});

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

it('parses every launch summary Core serves', () => {
  for (const name of readdirSync(CORE_FIXTURES).filter((file) =>
    /^launch_summary.*\.json$/.test(file)
  )) {
    const summary = coreFixture(name);
    expect(cloudLaunchSchema.parse(summary), name).toEqual(summary);
  }
});

it('parses a launch summary with its machine and process', () => {
  expect(launch).toMatchObject({
    machine_id: '3f1c2b4a-0000-4000-8000-000000000001',
    process_state: 'running',
    process_restarts: 0,
    oom_kills: 0,
  });
  expect(
    cloudLaunchSchema.parse({ ...launch, machine_id: null, process_state: null })
  ).toMatchObject({ machine_id: null, process_state: null });
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
  expect(cloudAgentPhase(launch, onMachine)).toBe(phase);
});

const stopped: CloudLaunch = { ...launch, desired_state: 'stopped', state: 'stopped' };
const crashed: CloudLaunch = {
  ...launch,
  state: 'error',
  error: 'crashed',
  error_code: 'agent_crashed',
  process_state: 'crashed',
};

it.each([
  ['stopped', stopped],
  ['crashed', crashed],
] as const)('does not sleep or wake with its machine a launch that is %s', (_name, onLaunch) => {
  expect(cloudAgentPhase(onLaunch, cloudMachineSchema.parse(idleSleeping))).toBeNull();
  expect(cloudAgentPhase({ ...onLaunch, sleeping: true, machine_id: null }, null)).toBeNull();
  expect(cloudAgentPhase(onLaunch, machine({ state: 'provisioning' }))).toBeNull();
});

it('reads a machine its owner stopped whatever the launch', () => {
  expect(
    cloudAgentPhase(
      stopped,
      machine({ state: 'stopped', desired_state: 'stopped', stop_reason: 'owner' })
    )
  ).toBe('machine_stopped');
});

it('reads a machine in error whatever the launch', () => {
  expect(cloudAgentPhase(stopped, machine({ state: 'error' }))).toBe('machine_error');
});

it('reads a machine in error before its owner stopping it', () => {
  expect(
    cloudAgentPhase(
      stopped,
      machine({ state: 'error', desired_state: 'stopped', stop_reason: 'owner' })
    )
  ).toBe('machine_error');
});

it('reads a launch without a machine from the launch', () => {
  expect(
    cloudAgentPhase({ ...launch, machine_id: null, sleeping: true, state: 'stopped' }, null)
  ).toBe('sleeping');
});
