import { describe, expect, it } from 'vitest';
import type { CloudMachine } from '@shared/core/cloud-agents/cloud-agents';
import { machinePresentation } from './cloud-machine-state';

const sleepingMachine: CloudMachine = {
  machine_id: '3f1c2b4a-0000-4000-8000-000000000001',
  state: 'stopped',
  desired_state: 'stopped',
  stop_reason: 'idle',
  sleeping: true,
  revision: 5,
  instance_type: 'c7i.2xlarge',
  error: null,
  error_code: null,
  retain_until: null,
  heartbeat_at: '2026-01-01T00:00:00Z',
  disk: { total_bytes: 214748364800, available_bytes: 204010946560 },
  memory: { total_bytes: 17179869184, available_bytes: 12884901888 },
  agents: ['req-0000000000000001'],
  runtime: 'worker',
  controller_id: null,
};

function machine(patch: Partial<CloudMachine>): CloudMachine {
  return { ...sleepingMachine, ...patch };
}

const NOW = Date.parse('2026-01-15T00:00:00Z');

function present(input: CloudMachine) {
  return machinePresentation(input, NOW);
}

const expiredRetained = {
  state: 'retained',
  desired_state: 'retained',
  sleeping: false,
  retain_until: '2026-01-01T00:00:00Z',
} as const;

const running = { desired_state: 'running', stop_reason: null, sleeping: false } as const;
const ownerStopped = { desired_state: 'stopped', stop_reason: 'owner', sleeping: false } as const;

describe('machinePresentation label', () => {
  it.each([
    ['sleeping stopped', machine({}), 'Sleeping'],
    ['sleeping stopping', machine({ state: 'stopping' }), 'Sleeping'],
    ['sleeping ready', machine({ state: 'ready' }), 'Sleeping'],
    ['owner stopped', machine({ ...ownerStopped }), 'Stopped'],
    ['owner stopping', machine({ ...ownerStopped, state: 'stopping' }), 'Stopping…'],
    ['queued', machine({ ...running, state: 'queued' }), 'Provisioning'],
    ['provisioning', machine({ ...running, state: 'provisioning' }), 'Provisioning'],
    ['waking from stopped', machine({ ...running, state: 'stopped' }), 'Provisioning'],
    ['waking while stopping', machine({ ...running, state: 'stopping' }), 'Provisioning'],
    ['ready', machine({ ...running, state: 'ready' }), 'Ready'],
    ['error', machine({ ...running, state: 'error', error_code: 'x' }), 'Error'],
    ['error while owner stopped', machine({ ...ownerStopped, state: 'error' }), 'Error'],
    ['error while sleeping', machine({ state: 'error', error_code: 'x' }), 'Error'],
    ['retained', machine({ state: 'retained', desired_state: 'retained' }), 'Retained'],
    ['retaining', machine({ ...running, state: 'ready', desired_state: 'retained' }), 'Retained'],
    ['reused while retained', machine({ ...running, state: 'retained' }), 'Provisioning'],
    ['deleting', machine({ state: 'deleting', desired_state: 'deleted' }), 'Deleting disk…'],
    [
      'error while deleting',
      machine({ state: 'error', desired_state: 'deleted', error_code: 'x' }),
      'Deleting disk…',
    ],
    ['retention expired', machine(expiredRetained), 'Deleting disk…'],
    [
      'error after retention expired',
      machine({ ...expiredRetained, state: 'error', error_code: 'other' }),
      'Deleting disk…',
    ],
  ])('%s', (_name, input, label) => {
    expect(present(input).label).toBe(label);
  });
});

describe('machinePresentation problem', () => {
  it('is null for a healthy machine', () => {
    expect(present(machine({})).problem).toBeNull();
  });

  it('names the machine that needs attention', () => {
    const shown = present(
      machine({ state: 'error', error_code: 'machine_needs_attention', error: 'raw' })
    );
    expect(shown.problem).toBe('The machine needs attention. Contact your server administrator.');
  });

  it('names a connect timeout', () => {
    const shown = present(machine({ state: 'error', error_code: 'machine_connect_timeout' }));
    expect(shown.problem).toMatch(/did not connect in time/);
  });

  it('falls back to the server error, then a generic one', () => {
    expect(present(machine({ state: 'error', error_code: 'other', error: 'boom' })).problem).toBe(
      'boom'
    );
    expect(present(machine({ state: 'error', error_code: 'other' })).problem).toBe(
      'The machine could not start.'
    );
  });

  it('shows a full disk on a ready machine', () => {
    const shown = present(machine({ ...running, state: 'ready', error_code: 'disk_full' }));
    expect(shown.problem).toBe('The machine’s disk is full.');
    expect(shown.label).toBe('Ready');
  });

  it('is null for a machine that errored while being deleted', () => {
    expect(
      present(
        machine({
          state: 'error',
          desired_state: 'deleted',
          error_code: 'other',
          error: 'Retry it in Switch Console.',
        })
      ).problem
    ).toBeNull();
  });

  it('is null for a machine in error whose retention expired', () => {
    expect(
      present(machine({ ...expiredRetained, state: 'error', error_code: 'other', error: 'boom' }))
        .problem
    ).toBeNull();
  });

  it.each([
    [
      'being deleted',
      machine({ state: 'error', desired_state: 'deleted', error_code: 'machine_needs_attention' }),
    ],
    [
      'past its retention',
      machine({ ...expiredRetained, state: 'error', error_code: 'machine_needs_attention' }),
    ],
  ])('names the machine that needs attention while %s', (_name, input) => {
    const shown = present(input);
    expect(shown.label).toBe('Error');
    expect(shown.problem).toBe('The machine needs attention. Contact your server administrator.');
    expect(shown.actions).toEqual([]);
  });

  it('ignores an error code on a machine that is not in error', () => {
    expect(
      present(machine({ ...running, state: 'ready', error_code: 'machine_needs_attention' }))
        .problem
    ).toBeNull();
  });
});

describe('machinePresentation retainUntil', () => {
  it('is the date a retained machine’s disk is deleted', () => {
    const shown = present(
      machine({
        state: 'retained',
        desired_state: 'retained',
        retain_until: '2026-02-01T00:00:00Z',
      })
    );
    expect(shown.retainUntil).toBe('2026-02-01T00:00:00Z');
  });

  it('is null once the retention has expired', () => {
    expect(present(machine(expiredRetained)).retainUntil).toBeNull();
  });

  it('is null otherwise', () => {
    expect(present(machine({ retain_until: '2026-02-01T00:00:00Z' })).retainUntil).toBeNull();
  });

  it('is null for a retained machine being reused', () => {
    expect(
      present(machine({ ...running, state: 'retained', retain_until: null })).retainUntil
    ).toBeNull();
  });

  it('is null for a machine that needs attention with expired retention', () => {
    expect(
      present(
        machine({
          state: 'error',
          desired_state: 'retained',
          error_code: 'machine_needs_attention',
          retain_until: '2026-01-01T00:00:00Z',
        })
      ).retainUntil
    ).toBeNull();
  });

  it('is null for an errored retained machine with future retain_until', () => {
    expect(
      present(
        machine({
          state: 'error',
          desired_state: 'retained',
          error_code: 'other',
          retain_until: '2026-02-01T00:00:00Z',
        })
      ).retainUntil
    ).toBeNull();
  });
});

describe('machinePresentation disk', () => {
  it('reads the heartbeat', () => {
    expect(present(machine({})).disk).toEqual({
      usedPercent: 5,
      availableBytes: 204010946560,
      totalBytes: 214748364800,
      low: false,
    });
  });

  it('is null without a heartbeat or with an empty total', () => {
    expect(present(machine({ disk: null })).disk).toBeNull();
    expect(present(machine({ disk: { total_bytes: 0, available_bytes: 0 } })).disk).toBeNull();
  });

  it('is low below a tenth free', () => {
    const at = (available: number) =>
      present(machine({ disk: { total_bytes: 1000, available_bytes: available } })).disk?.low;
    expect(at(100)).toBe(false);
    expect(at(99)).toBe(true);
  });
});

describe('machinePresentation actions', () => {
  it.each([
    ['sleeping stopped', machine({}), ['stop', 'start']],
    ['sleeping stopping', machine({ state: 'stopping' }), ['stop', 'start']],
    ['sleeping ready', machine({ state: 'ready' }), ['stop', 'start']],
    ['owner stopped', machine({ ...ownerStopped }), ['start']],
    ['owner stopping', machine({ ...ownerStopped, state: 'ready' }), ['start']],
    ['ready', machine({ ...running, state: 'ready' }), ['stop']],
    ['provisioning', machine({ ...running, state: 'provisioning' }), ['stop']],
    ['error', machine({ ...running, state: 'error', error_code: 'other' }), ['retry']],
    [
      'error while owner stopped',
      machine({ ...ownerStopped, state: 'error', error_code: 'other' }),
      ['retry'],
    ],
    ['error while sleeping', machine({ state: 'error', error_code: 'other' }), ['retry']],
    [
      'error needing attention while owner stopped',
      machine({ ...ownerStopped, state: 'error', error_code: 'machine_needs_attention' }),
      [],
    ],
    [
      'error needing attention',
      machine({ ...running, state: 'error', error_code: 'machine_needs_attention' }),
      [],
    ],
    ['retained', machine({ state: 'retained', desired_state: 'retained', sleeping: false }), []],
    ['retaining', machine({ ...running, state: 'ready', desired_state: 'retained' }), []],
    ['reused while retained', machine({ ...running, state: 'retained' }), []],
    ['deleting', machine({ state: 'deleting', desired_state: 'deleted', sleeping: false }), []],
    [
      'error while retaining',
      machine({ state: 'error', desired_state: 'retained', error_code: 'other' }),
      ['retry'],
    ],
    [
      'error while deleting',
      machine({ state: 'error', desired_state: 'deleted', error_code: 'other' }),
      [],
    ],
    [
      'error after retention expired',
      machine({ ...expiredRetained, state: 'error', error_code: 'other' }),
      [],
    ],
  ])('%s', (_name, input, actions) => {
    expect(present(input).actions).toEqual(actions);
  });
});
