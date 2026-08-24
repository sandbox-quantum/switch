import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two buses are kept apart here on purpose.
 *
 * `sessionService` and `sessionHooks` both carry an event called
 * `session:deleted`, and they fire on different paths — the second is how a
 * session pruned from its remote host is reported. Collapsing them into one map
 * of handlers, as an obvious test double would, makes a subscription to only
 * one of them look identical to a subscription to both.
 */
const { buses } = vi.hoisted(() => {
  type Handler = (...args: never[]) => void | Promise<void>;
  const make = () => {
    const handlers = new Map<string, Handler>();
    return {
      on: (name: string, handler: Handler) => handlers.set(name, handler),
      handlers,
    };
  };
  return { buses: { agents: make(), sessionService: make(), sessionHooks: make() } };
});

vi.mock('@main/core/agents/agent-events', () => ({ agentEvents: { on: buses.agents.on } }));
vi.mock('@main/core/sessions/session-service', () => ({
  sessionService: { on: buses.sessionService.on },
}));
vi.mock('@main/core/sessions/session-hooks', () => ({
  sessionHooks: { on: buses.sessionHooks.on },
}));
vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: vi.fn() }));
vi.mock('@main/core/locations/store', () => ({ getLocationById: vi.fn() }));
vi.mock('@main/core/sessions/operations/getSession', () => ({ getSession: vi.fn() }));
vi.mock('./telemetry-service', () => ({ trackEvent: vi.fn() }));

import { getAgentById } from '@main/core/agents/getAgentById';
import { getLocationById } from '@main/core/locations/store';
import { getSession } from '@main/core/sessions/operations/getSession';
import { registerTelemetryListeners } from './telemetry-listeners';
import { trackEvent } from './telemetry-service';

type Bus = keyof typeof buses;

async function emit(bus: Bus, name: string, ...args: unknown[]): Promise<void> {
  const handler = buses[bus].handlers.get(name);
  if (!handler) throw new Error(`nothing on the ${bus} bus subscribed to ${name}`);
  await (handler as (...a: unknown[]) => void | Promise<void>)(...args);
}

function onLocation(kind: 'local' | 'remote' | 'missing') {
  vi.mocked(getLocationById).mockResolvedValue(
    kind === 'missing'
      ? undefined
      : ({ id: 'loc', sshHost: kind === 'remote' ? 'host' : null } as never)
  );
}

function startSession(id: string, providerId = 'claude') {
  vi.mocked(getAgentById).mockResolvedValue({ id: 'agent', locationId: 'loc' } as never);
  return emit(
    'sessionService',
    'session:created',
    { id, agentId: 'agent', providerId },
    { id, agentId: 'agent', title: 'Session', entryPoint: 'sidebar' }
  );
}

/**
 * What every session start reports beyond the two dimensions under test.
 *
 * The helper above declares no start source, and that is reported as `unknown`:
 * a caller that said nothing is not evidence a person was there.
 */
const SESSION_START_CONTEXT = {
  outcome: 'success',
  failure_reason: 'none',
  entry_point: 'sidebar',
  start_source: 'unknown',
  has_initial_prompt: false,
  connected_to_room: false,
} as const;

registerTelemetryListeners();

beforeEach(() => {
  vi.mocked(trackEvent).mockClear();
});

describe('agent_created', () => {
  it('reports where the agent runs', async () => {
    onLocation('remote');

    await emit('agents', 'agent:created', { providerId: 'codex', locationId: 'loc' }, 'sidebar');

    expect(trackEvent).toHaveBeenCalledWith('agent_created', {
      agent_type: 'codex',
      location: 'remote',
      outcome: 'success',
      failure_reason: 'none',
      entry_point: 'sidebar',
    });
  });

  it('says unknown rather than guessing when the location has gone', async () => {
    onLocation('missing');

    await emit('agents', 'agent:created', { providerId: 'codex', locationId: 'gone' }, 'sidebar');

    expect(trackEvent).toHaveBeenCalledWith('agent_created', {
      agent_type: 'codex',
      location: 'unknown',
      outcome: 'success',
      failure_reason: 'none',
      entry_point: 'sidebar',
    });
  });

  it('does not pass through a provider id it does not recognise', async () => {
    // The column it comes from is typed, not constrained, so an unexpected
    // value would otherwise become free text in a payload.
    onLocation('local');

    await emit(
      'agents',
      'agent:created',
      { providerId: '/Users/someone/custom-agent', locationId: 'loc' },
      'sidebar'
    );

    expect(trackEvent).toHaveBeenCalledWith('agent_created', {
      agent_type: 'unknown',
      location: 'local',
      outcome: 'success',
      failure_reason: 'none',
      entry_point: 'sidebar',
    });
  });
});

describe('a session started in a room', () => {
  it('reports that a room was asked for, and who asked, never which room', async () => {
    onLocation('local');
    vi.mocked(getAgentById).mockResolvedValue({ id: 'agent', locationId: 'loc' } as never);

    await emit(
      'sessionService',
      'session:created',
      { id: 's-room', agentId: 'agent', providerId: 'claude' },
      {
        id: 's-room',
        agentId: 'agent',
        title: 'Session',
        entryPoint: 'sidebar',
        startSource: 'user',
        initialPrompt: 'connect to switch room alpha and audit the deploy',
        connectedToRoom: true,
      }
    );

    expect(trackEvent).toHaveBeenCalledWith('session_started', {
      ...SESSION_START_CONTEXT,
      agent_type: 'claude',
      location: 'local',
      start_source: 'user',
      has_initial_prompt: true,
      connected_to_room: true,
    });
    expect(JSON.stringify(vi.mocked(trackEvent).mock.calls)).not.toContain('alpha');
  });
});

describe('a session ending', () => {
  it('reports a deliberate end as normal', async () => {
    onLocation('local');
    await startSession('s-normal');
    expect(trackEvent).toHaveBeenCalledWith('session_started', {
      agent_type: 'claude',
      location: 'local',
      ...SESSION_START_CONTEXT,
    });

    await emit('sessionService', 'session:archived', 's-normal');

    expect(trackEvent).toHaveBeenCalledWith('session_ended', {
      agent_type: 'claude',
      location: 'local',
      outcome: 'normal',
    });
  });

  it('reports an exhausted crash as failed, with what the session was', async () => {
    onLocation('remote');
    await startSession('s-crash');

    await emit('sessionHooks', 'session:agent-exited', {
      sessionId: 's-crash',
      decision: 'failed',
    });

    expect(trackEvent).toHaveBeenCalledWith('session_ended', {
      agent_type: 'claude',
      location: 'remote',
      outcome: 'failed',
    });
  });

  it('counts a crash that is about to be respawned as no ending at all', async () => {
    onLocation('local');
    await startSession('s-respawn');
    vi.mocked(trackEvent).mockClear();

    await emit('sessionHooks', 'session:agent-exited', {
      sessionId: 's-respawn',
      decision: 'respawnResume',
    });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('ends a session once, not once per way of ending', async () => {
    onLocation('local');
    await startSession('s-twice');
    await emit('sessionHooks', 'session:agent-exited', {
      sessionId: 's-twice',
      decision: 'failed',
    });
    vi.mocked(trackEvent).mockClear();

    await emit('sessionService', 'session:deleted', 's-twice');

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('ends a second time once a restore has put it back into use', async () => {
    // The record of the first ending is there to collapse two endings moments
    // apart, not to retire a session id for the life of the run — an archived
    // session that is un-archived and later deleted has ended twice.
    onLocation('local');
    await startSession('s-unarchived');
    await emit('sessionService', 'session:archived', 's-unarchived');
    vi.mocked(trackEvent).mockClear();

    await emit('sessionService', 'session:restored', 's-unarchived');
    await emit('sessionService', 'session:deleted', 's-unarchived');

    // Unknown because a restore is the row coming back, not the session
    // running again: what it is gets re-learned when its runtime does.
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('session_ended', {
      agent_type: 'unknown',
      location: 'unknown',
      outcome: 'normal',
    });
  });

  it('reports one pruned from its remote host, which arrives on the other bus', async () => {
    // The reconciler deletes the row itself when a session has gone from the
    // VM, or was terminated from another client. Subscribing only to the
    // session service leaves those reporting a start and never an end.
    onLocation('remote');
    await startSession('s-pruned');
    vi.mocked(trackEvent).mockClear();

    await emit('sessionHooks', 'session:deleted', 's-pruned');

    expect(trackEvent).toHaveBeenCalledWith('session_ended', {
      agent_type: 'claude',
      location: 'remote',
      outcome: 'normal',
    });
  });
});

describe('a session that outlived a restart', () => {
  it('is recognised when its runtime comes back, without counting as new', async () => {
    onLocation('remote');
    vi.mocked(getSession).mockResolvedValue({ id: 's-restored', providerId: 'codex' } as never);

    await emit('sessionService', 'session:runtime-ready', 's-restored', {
      path: '/somewhere',
      locationId: 'loc',
    });

    expect(trackEvent).not.toHaveBeenCalled();

    await emit('sessionService', 'session:deleted', 's-restored');

    expect(trackEvent).toHaveBeenCalledWith('session_ended', {
      agent_type: 'codex',
      location: 'remote',
      outcome: 'normal',
    });
  });

  it('does not overwrite what a session that started here is known to be', async () => {
    onLocation('local');
    await startSession('s-known');
    vi.mocked(getSession).mockResolvedValue({ id: 's-known', providerId: 'codex' } as never);
    onLocation('remote');

    await emit('sessionService', 'session:runtime-ready', 's-known', {
      path: '/somewhere',
      locationId: 'loc',
    });
    await emit('sessionService', 'session:deleted', 's-known');

    expect(trackEvent).toHaveBeenLastCalledWith('session_ended', {
      agent_type: 'claude',
      location: 'local',
      outcome: 'normal',
    });
  });

  it('is still reported as unknown if its row has gone by the time it ends', async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    await emit('sessionService', 'session:runtime-ready', 's-vanished', {
      path: '/somewhere',
      locationId: 'loc',
    });
    await emit('sessionService', 'session:deleted', 's-vanished');

    expect(trackEvent).toHaveBeenCalledWith('session_ended', {
      agent_type: 'unknown',
      location: 'unknown',
      outcome: 'normal',
    });
  });
});

describe('a session that dies before we know what it was', () => {
  // A session is created with its agent already running, so these handlers can
  // genuinely interleave. `emit` awaits each handler to completion, so the race
  // has to be built deliberately rather than hoped for.
  it('is not reported as starting after it has already ended', async () => {
    let releaseLookup = () => {};
    vi.mocked(getAgentById).mockReturnValue(
      new Promise((resolve) => {
        releaseLookup = () => resolve({ id: 'agent', locationId: 'loc' } as never);
      }) as never
    );
    onLocation('local');

    const created = emit('sessionService', 'session:created', {
      id: 's-fast-crash',
      agentId: 'agent',
      providerId: 'claude',
    });
    await emit('sessionHooks', 'session:agent-exited', {
      sessionId: 's-fast-crash',
      decision: 'failed',
    });
    releaseLookup();
    await created;

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('session_ended', {
      agent_type: 'unknown',
      location: 'unknown',
      outcome: 'failed',
    });
  });

  it('leaves nothing behind when it ends twice', async () => {
    // The second ending reports nothing, but it must still clear the entry —
    // otherwise the map keeps it for the life of the process.
    onLocation('local');
    await startSession('s-double');
    await emit('sessionService', 'session:archived', 's-double');
    vi.mocked(trackEvent).mockClear();

    await emit('sessionHooks', 'session:deleted', 's-double');

    expect(trackEvent).not.toHaveBeenCalled();
  });
});

describe('the memory of what has ended', () => {
  it('does not grow without limit', async () => {
    // A long-running app ends a lot of sessions; the set only exists to
    // recognise a second ending moments after the first.
    for (let i = 0; i < 300; i++) {
      await emit('sessionService', 'session:deleted', `bulk-${i}`);
    }
    vi.mocked(trackEvent).mockClear();

    // The oldest have been forgotten, so this one reports again rather than
    // being suppressed forever.
    await emit('sessionService', 'session:deleted', 'bulk-0');

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it('still suppresses a repeat that arrives while it is remembered', async () => {
    await emit('sessionService', 'session:deleted', 'recent');
    vi.mocked(trackEvent).mockClear();

    await emit('sessionService', 'session:deleted', 'recent');

    expect(trackEvent).not.toHaveBeenCalled();
  });
});
