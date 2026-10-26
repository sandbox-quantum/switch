import { describe, expect, it } from 'vitest';
import type {
  MachineDetail,
  MachineProviderDetail,
} from '@shared/core/managed-agents/managed-agents';
import {
  arrangeMachines,
  controllerRelease,
  lastContact,
  machineCategory,
  machineConnection,
  machineNotices,
  moveTarget,
  platformLabel,
  sessionsLabel,
} from './machine-state';

function machine(patch: Partial<MachineDetail> & { id: string }): MachineDetail {
  return {
    name: patch.id,
    kind: 'daemon',
    state: 'online',
    providers: [],
    acceptsLogins: false,
    cloud: false,
    workspacesDir: null,
    os: null,
    local: null,
    description: null,
    platform: null,
    version: null,
    connection: {
      connectedAt: '2026-10-01T10:00:00Z',
      disconnectedAt: null,
      disconnectReason: null,
    },
    release: null,
    updatedBy: null,
    update: null,
    resources: null,
    agents: [],
    lastSeenAt: null,
    observedAt: null,
    createdAt: null,
    revokedAt: null,
    ...patch,
  };
}

describe('machineConnection', () => {
  it('says why an offline machine went', () => {
    const shown = machineConnection(
      machine({
        id: 'm',
        state: 'offline',
        connection: {
          connectedAt: '2026-10-01T10:00:00Z',
          disconnectedAt: '2026-10-01T11:00:00Z',
          disconnectReason: 'heartbeat_lapsed',
        },
      })
    );
    expect(shown.label).toBe('Offline');
    expect(shown.tone).toBe('problem');
    expect(shown.title).toContain('its connection stopped responding');
  });

  it('tells a machine that never connected from one that went', () => {
    expect(machineConnection(machine({ id: 'm', state: 'unknown', connection: null })).label).toBe(
      'Never connected'
    );
  });
});

describe('controllerRelease', () => {
  it('flags nothing for a machine Console updates', () => {
    expect(controllerRelease(machine({ id: 'm', kind: 'console' }))).toEqual({
      title: 'Updates with Switch Console, which runs it.',
      badge: null,
    });
  });

  it('says a controller waiting for its sessions to end will update when idle', () => {
    const shown = controllerRelease(
      machine({
        id: 'm',
        version: '1.0.0',
        release: { wanted: '1.1.0', running: '1.0.0', current: false },
        update: { target: '1.1.0', state: 'waiting_idle', problem: null },
      })
    );
    expect(shown.badge).toEqual({ label: 'Updating when idle', tone: 'warning' });
  });

  it('calls a controller behind when it says nothing about the release', () => {
    const shown = controllerRelease(
      machine({ id: 'm', release: { wanted: '1.1.0', running: '1.0.0', current: false } })
    );
    expect(shown.badge?.label).toBe('Behind');
  });
});

describe('lastContact', () => {
  it('is the latest of what Switch heard while the machine is offline', () => {
    expect(
      lastContact(
        machine({
          id: 'm',
          state: 'offline',
          lastSeenAt: '2026-10-01T10:30:00Z',
          connection: {
            connectedAt: '2026-10-01T10:00:00Z',
            disconnectedAt: '2026-10-01T11:00:00Z',
            disconnectReason: null,
          },
        }),
        new Date('2026-10-02T00:00:00Z')
      )
    ).toBe('2026-10-01T11:00:00Z');
  });
});

describe('platformLabel', () => {
  it('names the operating system the way people do', () => {
    expect(platformLabel({ os: 'macos', arch: 'arm64', osVersion: '15.1' })).toBe(
      'macOS 15.1 · arm64'
    );
    expect(platformLabel(null)).toBeNull();
  });
});

describe('arrangeMachines', () => {
  it('puts this computer first, connected machines next, and removed ones apart', () => {
    const { live, removed } = arrangeMachines([
      machine({ id: 'b-offline', state: 'offline' }),
      machine({ id: 'a-online' }),
      machine({ id: 'gone', state: 'revoked' }),
      machine({ id: 'z-laptop', local: { kind: 'this-computer' } }),
    ]);
    expect(live.map((m) => m.id)).toEqual(['z-laptop', 'a-online', 'b-offline']);
    expect(removed.map((m) => m.id)).toEqual(['gone']);
  });
});

describe('machineNotices', () => {
  it('has nothing to say about a healthy machine', () => {
    expect(machineNotices(machine({ id: 'm' }))).toEqual([]);
  });

  it('says a machine is offline, and why', () => {
    const [notice] = machineNotices(
      machine({
        id: 'm',
        state: 'offline',
        connection: {
          connectedAt: '2026-10-01T10:00:00Z',
          disconnectedAt: '2026-10-01T11:00:00Z',
          disconnectReason: 'heartbeat_lapsed',
        },
      })
    );
    expect(notice).toMatchObject({ key: 'connection', tone: 'problem', title: 'Offline' });
    expect(notice!.body).toContain('its connection stopped responding');
  });

  it('says only that a removed machine is removed', () => {
    const notices = machineNotices(
      machine({
        id: 'm',
        state: 'revoked',
        revokedAt: '2026-10-02T10:00:00Z',
        release: { wanted: '1.1.0', running: '1.0.0', current: false },
      })
    );
    expect(notices.map((n) => n.title)).toEqual(['Removed']);
  });

  it('flags a controller behind its release and providers that cannot run', () => {
    const notices = machineNotices(
      machine({
        id: 'm',
        release: { wanted: '1.1.0', running: '1.0.0', current: false },
        providers: [
          {
            provider: 'acme',
            ready: false,
            problem: 'login expired',
            detail: null,
            version: null,
            authSource: null,
            checkedAt: null,
          },
          {
            provider: 'other',
            ready: false,
            problem: 'not installed',
            detail: null,
            version: null,
            authSource: null,
            checkedAt: null,
          },
        ],
      })
    );
    expect(notices.map((n) => n.key)).toEqual(['release', 'providers']);
    expect(notices[1]!.body).toBe('acme: login expired');
  });
});

describe('sessionsLabel', () => {
  const resources = {
    diskFreeBytes: 1,
    diskTotalBytes: 2,
    memFreeBytes: 1,
    memTotalBytes: 2,
    sessionsRunning: 1,
  };

  it('shows the limit when there is one', () => {
    expect(sessionsLabel({ ...resources, sessionsMax: 4 })).toBe('1 of 4');
  });

  it('shows only the count when the controller enforces no limit', () => {
    expect(sessionsLabel({ ...resources, sessionsMax: 0 })).toBe('1');
  });
});

describe('moveTarget', () => {
  const ready: MachineProviderDetail = {
    provider: 'claude',
    ready: true,
    problem: null,
    detail: null,
    version: null,
    authSource: null,
    checkedAt: null,
  };

  it('takes an agent on a connected machine with its provider signed in', () => {
    expect(moveTarget(machine({ id: 'm', providers: [ready] }), 'claude')).toMatchObject({
      selectable: true,
      tone: 'ok',
    });
  });

  it('refuses what Switch refuses: offline, not installed, signed out', () => {
    expect(
      moveTarget(machine({ id: 'm', state: 'offline', providers: [ready] }), 'claude')
    ).toMatchObject({
      selectable: false,
      line: 'Offline. Bring it online to move agents here.',
    });
    expect(moveTarget(machine({ id: 'm', providers: [] }), 'claude').selectable).toBe(false);
    for (const problem of ['not installed', 'not logged in', 'login expired'])
      expect(
        moveTarget(machine({ id: 'm', providers: [{ ...ready, ready: false, problem }] }), 'claude')
          .selectable
      ).toBe(false);
  });

  it('lets a sign-in not checked yet through, as Switch does', () => {
    expect(
      moveTarget(
        machine({
          id: 'm',
          providers: [{ ...ready, ready: false, problem: 'login not checked yet' }],
        }),
        'claude'
      )
    ).toMatchObject({ selectable: true, tone: 'warning' });
  });
});

describe('machineCategory', () => {
  it('groups the cloud machine, SSH hosts and every other computer', () => {
    expect(machineCategory(machine({ id: 'c', cloud: true }))).toBe('cloud');
    expect(machineCategory(machine({ id: 's', local: { kind: 'ssh-host', sshHost: 'box' } }))).toBe(
      'ssh-host'
    );
    expect(machineCategory(machine({ id: 't', local: { kind: 'this-computer' } }))).toBe(
      'computer'
    );
    expect(machineCategory(machine({ id: 'd' }))).toBe('computer');
  });
});
