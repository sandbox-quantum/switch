import { describe, expect, it } from 'vitest';
import { adminGroups } from '@renderer/features/admin/admin-sections';
import { boxShowsStopped } from '@renderer/features/cloud-agents/your-cloud';
import { managedAgentState } from '@renderer/features/managed-agents/managed-agent-state';
import {
  gigabytes,
  isolationText,
  replyAgo,
  ROOM_BAND,
  sumKnown,
  sharedCloudFromSession,
  sharedCloudPresentation,
  showsSharedCloudState,
} from '@renderer/features/shared-cloud/shared-cloud-state';
import { adminNavTarget, workspaceNavViews } from '@renderer/features/sidebar/workspace-nav-views';

const now = new Date('2026-10-22T12:00:00Z');

describe('an agent on the shared cloud, as a person reads it', () => {
  it('says where a working agent is replying, without a last-reply time', () => {
    expect(
      sharedCloudPresentation(
        {
          agent_id: 'a',
          state: 'working',
          room_name: 'Off-Topic',
          last_reply_at: now.toISOString(),
        },
        now
      )
    ).toEqual({ label: 'Working', detail: 'Replying in Off-Topic', tone: 'working', when: null });
  });

  it('calls a parked agent resting, and says it is back in seconds', () => {
    const shown = sharedCloudPresentation(
      { agent_id: 'a', state: 'resting', last_reply_at: '2026-10-22T11:56:00Z' },
      now
    );
    expect(shown.label).toBe('Resting');
    expect(shown.detail).toBe('Wakes when you message it');
    expect(shown.when).toBe('last reply 4 min ago');
  });

  it('says Stopped for a resting agent on a box Your cloud shows as Stopped', () => {
    const resting = { agent_id: 'a', state: 'resting' as const, box_stopped: true };
    expect(sharedCloudPresentation(resting, now, true)).toMatchObject({
      label: 'Stopped',
      detail: 'Start your cloud to use it',
    });
    expect(sharedCloudPresentation(resting, now).label).toBe('Resting');
    // A failure keeps its own words on a stopped box.
    expect(
      sharedCloudPresentation({ agent_id: 'a', state: 'unavailable', paused: true }, now, true)
        .label
    ).toBe('Paused by Switch');
  });

  it('never lets a failure pass for resting', () => {
    const shown = sharedCloudPresentation({ agent_id: 'a', state: 'unavailable' }, now);
    expect(shown).toMatchObject({ label: "Can't reply right now", tone: 'problem' });
  });

  it('leaves out the last reply when there has never been one', () => {
    expect(sharedCloudPresentation({ agent_id: 'a', state: 'idle' }, now).when).toBeNull();
  });
});

describe('the shared machines in Admin', () => {
  const person = { administers: false, operator: false, serviceConnections: false, managed: false };

  it('lists them under Server, for the operator the server shows them to', () => {
    expect(adminGroups({ ...person, sharedCloud: true })).toEqual([
      { scope: 'server', items: ['cloud'] },
    ]);
    expect(
      adminGroups({ ...person, administers: true, serviceConnections: true, sharedCloud: true })
    ).toEqual([
      { scope: 'workspace', items: ['connectors'] },
      { scope: 'server', items: ['cloud'] },
    ]);
  });

  it('never offers them to a workspace admin the server does not show them to', () => {
    expect(adminGroups({ ...person, administers: true })).toEqual([]);
  });

  it('shows the sidebar Admin entry for an operator, even without service connections', () => {
    expect(
      workspaceNavViews({
        managed: false,
        serviceConnections: false,
        administers: false,
        sharedCloud: true,
      })
    ).toContain('admin');
    expect(
      workspaceNavViews({ managed: false, serviceConnections: false, administers: true })
    ).not.toContain('admin');
    expect(
      adminNavTarget({
        serviceConnections: false,
        administers: false,
        frozen: false,
        sharedCloud: true,
      })
    ).toBe('admin');
  });
});

describe('what replaces the usual status line', () => {
  it('only resting, waking and a failed resume; working and idle read as everywhere else', () => {
    expect(showsSharedCloudState({ agent_id: 'a', state: 'resting' })).toBe(true);
    expect(showsSharedCloudState({ agent_id: 'a', state: 'waking' })).toBe(true);
    expect(showsSharedCloudState({ agent_id: 'a', state: 'unavailable' })).toBe(true);
    expect(showsSharedCloudState({ agent_id: 'a', state: 'working' })).toBe(false);
    expect(showsSharedCloudState({ agent_id: 'a', state: 'idle' })).toBe(false);
  });
});

describe('figures', () => {
  it('writes memory in GB to one place below ten', () => {
    expect(gigabytes(3.5 * 1024 ** 3)).toBe('3.5 GB');
    expect(gigabytes(16 * 1024 ** 3)).toBe('16 GB');
  });

  it('says plainly when isolation has not been checked', () => {
    expect(isolationText('unknown')).toBe('Not checked yet');
  });
});

describe('honest figures for a workspace admin', () => {
  it('gives no total when any part is unknown, rather than a partial one', () => {
    expect(sumKnown([1, 2])).toBe(3);
    expect(sumKnown([1, null])).toBeNull();
  });

  it('says plainly when the room left is unknown', () => {
    expect(ROOM_BAND.unknown.label).toBe('Unknown');
    expect(ROOM_BAND.plenty.label).toBe('Plenty');
  });
});

describe('last reply, in one style', () => {
  it('reads evenly across minutes, hours and days', () => {
    expect(replyAgo('2026-10-22T11:59:40Z', now)).toBe('just now');
    expect(replyAgo('2026-10-22T11:56:00Z', now)).toBe('4 min ago');
    expect(replyAgo('2026-10-22T10:00:00Z', now)).toBe('2 h ago');
    expect(replyAgo('2026-10-21T10:00:00Z', now)).toBe('yesterday');
    expect(replyAgo('2026-10-19T10:00:00Z', now)).toBe('3 days ago');
  });
});

describe('the session state the controller reports (F5)', () => {
  const agent = (session: 'active' | 'waking' | 'parked' | null | undefined) =>
    ({
      agentId: 'a1',
      status:
        session === undefined
          ? null
          : {
              process: 'running',
              attached: true,
              reason: null,
              detail: null,
              directory: null,
              session,
            },
    }) as unknown as Parameters<typeof sharedCloudFromSession>[0];

  it('shows a parked session as Resting and a waking one as Back in a moment', () => {
    expect(sharedCloudFromSession(agent('parked'))).toEqual({ agent_id: 'a1', state: 'resting' });
    expect(sharedCloudFromSession(agent('waking'))).toEqual({ agent_id: 'a1', state: 'waking' });
  });

  // B48: a host its controller gave up on stays down until its owner restarts it.
  const gaveUp = (over: Record<string, unknown> = {}) =>
    ({
      agentId: 'a1',
      desiredState: 'running',
      machine: { id: 'box', name: 'box', kind: 'daemon', state: 'online' },
      status: {
        process: 'failed',
        attached: false,
        reason: 'internal',
        detail: null,
        directory: null,
      },
      ...over,
    }) as unknown as Parameters<typeof sharedCloudFromSession>[0];

  it("shows a host that gave up on a shared box as Can't reply right now · Needs a restart", () => {
    const state = sharedCloudFromSession(gaveUp(), true);
    expect(state).toEqual({ agent_id: 'a1', state: 'unavailable', needs_restart: true });
    const shown = sharedCloudPresentation(state!, now);
    expect(shown.label).toBe("Can't reply right now");
    expect(shown.detail).toBe('Needs a restart');
    expect(shown.tone).toBe('problem');
    expect(showsSharedCloudState(state!)).toBe(true);
  });

  it('sends the owner to the agent for a failed host with any other reason', () => {
    const other = gaveUp();
    (other.status as { reason: string }).reason = 'provider_login_missing';
    const state = sharedCloudFromSession(other, true);
    expect(state).toEqual({ agent_id: 'a1', state: 'unavailable', needs_check: true });
    expect(sharedCloudPresentation(state!, now).detail).toBe('Open it to see why');
  });

  it('keeps "Try again in a few minutes" for an unavailable agent that needs no restart', () => {
    expect(sharedCloudPresentation({ agent_id: 'a1', state: 'unavailable' }, now).detail).toBe(
      'Try again in a few minutes'
    );
  });

  it("leaves a failed host off the shared cloud with today's wording, as prod has it", () => {
    expect(sharedCloudFromSession(gaveUp(), false)).toBeNull();
    expect(sharedCloudFromSession(gaveUp())).toBeNull();
  });

  it('says nothing new when the owner stopped it, or its box is offline', () => {
    expect(sharedCloudFromSession(gaveUp({ desiredState: 'stopped' }), true)).toBeNull();
    expect(
      sharedCloudFromSession(
        gaveUp({ machine: { id: 'box', name: 'box', kind: 'daemon', state: 'offline' } }),
        true
      )
    ).toBeNull();
  });

  it('treats a crashed host that is still being restarted as nothing new', () => {
    const crashed = gaveUp();
    (crashed.status as { process: string }).process = 'crashed';
    expect(sharedCloudFromSession(crashed, true)).toBeNull();
  });

  it("shows a guard stop as Can't reply right now · Stopped: used too much memory", () => {
    const stopped = gaveUp();
    Object.assign(stopped.status as Record<string, unknown>, {
      process: 'stopped',
      reason: 'out_of_memory',
    });
    const state = sharedCloudFromSession(stopped, true);
    expect(state).toEqual({ agent_id: 'a1', state: 'unavailable', memory_stopped: true });
    expect(sharedCloudPresentation(state!, now).detail).toBe('Stopped: used too much memory');
    // An owner's stop, or a box off the shared cloud, keeps today's state.
    expect(
      sharedCloudFromSession({ ...stopped, desiredState: 'stopped' } as typeof stopped, true)
    ).toBeNull();
    expect(sharedCloudFromSession(stopped, false)).toBeNull();
  });

  it('shows a conversation waiting for room as Back in a moment · Waiting for room', () => {
    const waiting = agent('parked');
    (waiting.status as Record<string, unknown>).waitingForRoom = {
      count: 1,
      oldestSince: '2026-10-27T10:00:00Z',
    };
    const state = sharedCloudFromSession(waiting, true);
    expect(state).toEqual({ agent_id: 'a1', state: 'waking', waiting_for_room: true });
    const shown = sharedCloudPresentation(state!, now);
    expect(shown.label).toBe('Back in a moment');
    expect(shown.detail).toBe('Waiting for room');
    expect(shown.tone).toBe('waking');
    // Off a shared-cloud box it reads as before.
    expect(sharedCloudFromSession(waiting, false)).toEqual({ agent_id: 'a1', state: 'resting' });
  });

  // L2-IS-1: a box stopped on purpose after a quiet spell, and starting again.
  const offline = () =>
    ({
      ...gaveUp(),
      machine: { id: 'box', name: 'box', kind: 'daemon', state: 'offline' },
      status: { process: 'running', attached: false, reason: null, detail: null, directory: null },
    }) as unknown as Parameters<typeof sharedCloudFromSession>[0];
  const sleeping = { state: 'stopped', desired_state: 'stopped', sleeping: true } as const;
  const starting = { state: 'provisioning', desired_state: 'running', sleeping: false } as const;

  it('shows an idle-stopped box as Resting · Starts when messaged, not Machine offline', () => {
    const state = sharedCloudFromSession(offline(), true, sleeping);
    expect(state).toEqual({ agent_id: 'a1', state: 'resting', box_stopped: true });
    const shown = sharedCloudPresentation(state!, now);
    expect([shown.label, shown.detail, shown.tone]).toEqual([
      'Resting',
      'Starts when messaged',
      'resting',
    ]);
  });

  it('shows a box starting after an idle stop as Back in a moment · Starting your cloud', () => {
    const state = sharedCloudFromSession(offline(), true, starting);
    expect(state).toEqual({ agent_id: 'a1', state: 'waking', box_starting: true });
    expect(sharedCloudPresentation(state!, now).detail).toBe('Starting your cloud');
  });

  it("shows a box whose start failed as Can't reply right now · Open it to see why, never amber", () => {
    const failed = { state: 'error', desired_state: 'running', sleeping: false } as const;
    const state = sharedCloudFromSession(offline(), true, failed);
    expect(state).toEqual({ agent_id: 'a1', state: 'unavailable', needs_check: true });
    expect(sharedCloudPresentation(state!, now).detail).toBe('Open it to see why');
  });

  it('shows an owner-stopped box as Stopped · Start your cloud to use it, in a calm tone, never Machine offline', () => {
    const ownerStopped = { state: 'stopped', desired_state: 'stopped', sleeping: false } as const;
    const state = sharedCloudFromSession(offline(), true, ownerStopped, false, true);
    expect(state).toEqual({ agent_id: 'a1', state: 'resting', box_stopped: true });
    const shown = sharedCloudPresentation(state!, now, true);
    expect([shown.label, shown.detail, shown.tone]).toEqual([
      'Stopped',
      'Start your cloud to use it',
      'resting',
    ]);
    // The flag the cards pass comes from Your cloud's own reading of the box.
    expect(
      boxShowsStopped({
        ...ownerStopped,
        stop_reason: 'owner',
        room: null,
        awake: null,
        ai_calls_today: null,
        agents: ['a1'],
      } as Parameters<typeof boxShowsStopped>[0])
    ).toBe(true);
  });

  it('a machine that is truly offline (not a stopped box) still reads Machine offline', () => {
    const upButUnreachable = { state: 'ready', desired_state: 'running', sleeping: false } as const;
    expect(sharedCloudFromSession(offline(), true, upButUnreachable, false, false)).toBeNull();
    expect(managedAgentState(offline() as Parameters<typeof managedAgentState>[0])).toMatchObject({
      label: 'Machine offline',
      tone: 'problem',
    });
  });

  it("keeps today's states for a box that's down without an idle stop, or off the shared cloud", () => {
    const down = { state: 'stopped', desired_state: 'running', sleeping: false } as const;
    // Down, wanted running, controller offline: starting is the honest reading only
    // while the machine is being started; a box Core reports ready but offline isn't.
    expect(sharedCloudFromSession(offline(), true, { ...down, state: 'ready' })).toBeNull();
    expect(sharedCloudFromSession(offline(), false, sleeping)).toBeNull();
    expect(sharedCloudFromSession(offline(), true, null)).toBeNull();
    expect(
      sharedCloudFromSession(
        { ...offline(), desiredState: 'stopped' } as unknown as Parameters<
          typeof sharedCloudFromSession
        >[0],
        true,
        sleeping
      )
    ).toBeNull();
  });

  it("leaves a loaded session, or one that isn't reported, with its usual status", () => {
    expect(sharedCloudFromSession(agent('active'))).toBeNull();
    expect(sharedCloudFromSession(agent(null))).toBeNull();
    expect(sharedCloudFromSession(agent(undefined))).toBeNull();
  });
});
