import { describe, expect, it } from 'vitest';
import { cloudMachineSchema } from '@shared/core/cloud-agents/cloud-agents';
import { DISK_NOT_AVAILABLE, gb, hostedSummary, workspaceDisk } from './hosted-summary';

const GiB = 1024 ** 3;

const machine = (over: Partial<Parameters<typeof hostedSummary>[0]> = {}) => ({
  agents: ['a1', 'a2', 'a3'],
  awake: { running: 3, max: 12 },
  room: { used_bytes: 3 * GiB, total_bytes: 8 * GiB },
  disk: { total_bytes: 15 * GiB, available_bytes: 11 * GiB, scope: 'workspace' },
  ...over,
});

describe('hostedSummary', () => {
  it('says how many hosted agents, awake out of the limit, memory and the workspace disk', () => {
    expect(hostedSummary(machine())).toEqual({
      agents: '3 hosted agents',
      awake: { label: 'Agents awake: 3 of 12', usedPercent: 25, step: 'ok' },
      memory: { label: 'Memory: 3.0 GB of 8.0 GB', usedPercent: 37.5, step: 'ok' },
      disk: { label: 'Disk: 4.0 GB of 15.0 GB', usedPercent: 26.7, step: 'ok' },
    });
    expect(hostedSummary(machine({ agents: ['a1'] })).agents).toBe('1 hosted agent');
    expect(hostedSummary(machine({ agents: [] })).agents).toBe('0 hosted agents');
  });

  it('marks nearly full above 80% and full from 95%, the same steps as Switch web', () => {
    expect(hostedSummary(machine({ awake: { running: 10, max: 12 } })).awake?.step).toBe(
      'nearly_full'
    );
    expect(hostedSummary(machine({ awake: { running: 12, max: 12 } })).awake?.step).toBe('full');
    expect(
      hostedSummary(machine({ room: { used_bytes: 8 * 0.8 * GiB, total_bytes: 8 * GiB } })).memory
        ?.step
    ).toBe('ok');
    expect(
      hostedSummary(
        machine({ disk: { total_bytes: 15 * GiB, available_bytes: 0.5 * GiB, scope: 'workspace' } })
      ).disk?.step
    ).toBe('full');
  });

  it('never shows the controller’s own small disk: without the workspace marker it’s not available', () => {
    const old = machine({ disk: { total_bytes: 2 * GiB, available_bytes: 1 * GiB } });
    expect(hostedSummary(old).disk).toBeNull();
    expect(workspaceDisk(old)).toBeNull();
    expect(workspaceDisk(machine({ disk: null }))).toBeNull();
    expect(
      workspaceDisk(machine({ disk: { total_bytes: 0, available_bytes: 0, scope: 'workspace' } }))
    ).toBeNull();
    expect(DISK_NOT_AVAILABLE).toBe('Disk: not available');
  });

  it('leaves out a figure the box doesn’t report, rather than showing zero', () => {
    const quiet = hostedSummary(machine({ awake: null, room: null }));
    expect(quiet.awake).toBeNull();
    expect(quiet.memory).toBeNull();
    expect(hostedSummary(machine({ awake: { running: 0, max: 0 } })).awake).toBeNull();
  });

  it('reads the disk marker from the server’s answer, and drops a marker out of shape', () => {
    const base = {
      machine_id: 'm1',
      state: 'ready',
      desired_state: 'running',
      stop_reason: null,
      sleeping: false,
      revision: 1,
      instance_type: null,
      error: null,
      error_code: null,
      retain_until: null,
      heartbeat_at: null,
      memory: null,
      agents: [],
      controller_id: null,
    };
    const good = cloudMachineSchema.parse({
      ...base,
      disk: { total_bytes: 15 * GiB, available_bytes: GiB, scope: 'workspace' },
    });
    expect(workspaceDisk(good)).not.toBeNull();
    const odd = cloudMachineSchema.parse({
      ...base,
      disk: { total_bytes: 15 * GiB, available_bytes: GiB, scope: 7 },
    });
    expect(odd.disk?.scope).toBeUndefined();
    expect(workspaceDisk(odd)).toBeNull();
  });

  it('prints gigabytes with one decimal', () => {
    expect(gb(15 * GiB)).toBe('15.0 GB');
    expect(gb(1.25 * GiB)).toBe('1.3 GB');
  });
});
