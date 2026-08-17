import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => void>(),
}));

function register(name: string, handler: (...args: never[]) => void) {
  handlers.set(name, handler);
}

vi.mock('@main/core/agents/agent-events', () => ({ agentEvents: { on: register } }));
vi.mock('@main/core/sessions/session-service', () => ({ sessionService: { on: register } }));
vi.mock('@main/core/sessions/session-hooks', () => ({ sessionHooks: { on: register } }));
vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: vi.fn() }));
vi.mock('@main/core/locations/store', () => ({ getLocationById: vi.fn() }));
vi.mock('./telemetry-service', () => ({ trackEvent: vi.fn() }));

import { getAgentById } from '@main/core/agents/getAgentById';
import { getLocationById } from '@main/core/locations/store';
import { registerTelemetryListeners } from './telemetry-listeners';
import { trackEvent } from './telemetry-service';

type Emit = (...args: never[]) => void | Promise<void>;

async function emit(name: string, ...args: unknown[]): Promise<void> {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`nothing subscribed to ${name}`);
  await (handler as Emit)(...(args as never[]));
}

function onLocation(kind: 'local' | 'remote' | 'missing') {
  vi.mocked(getLocationById).mockResolvedValue(
    kind === 'missing'
      ? undefined
      : ({ id: 'loc', sshHost: kind === 'remote' ? 'host' : null } as never)
  );
}

function startSession(id: string) {
  vi.mocked(getAgentById).mockResolvedValue({ id: 'agent', locationId: 'loc' } as never);
  return emit('session:created', { id, agentId: 'agent', providerId: 'claude' });
}

registerTelemetryListeners();

beforeEach(() => {
  vi.mocked(trackEvent).mockClear();
});

describe('agent_created', () => {
  it('reports where the agent runs', async () => {
    onLocation('remote');

    await emit('agent:created', { providerId: 'codex', locationId: 'loc' });

    expect(trackEvent).toHaveBeenCalledWith('agent_created', {
      agent_type: 'codex',
      location: 'remote',
    });
  });

  it('says unknown rather than guessing when the location has gone', async () => {
    onLocation('missing');

    await emit('agent:created', { providerId: 'codex', locationId: 'gone' });

    expect(trackEvent).toHaveBeenCalledWith('agent_created', {
      agent_type: 'codex',
      location: 'unknown',
    });
  });
});

describe('a session ending', () => {
  it('reports a deliberate end as normal', async () => {
    onLocation('local');
    await startSession('s-normal');
    expect(trackEvent).toHaveBeenCalledWith('session_started', {
      agent_type: 'claude',
      location: 'local',
    });

    await emit('session:archived', 's-normal');

    expect(trackEvent).toHaveBeenCalledWith('session_ended', {
      agent_type: 'claude',
      location: 'local',
      outcome: 'normal',
    });
  });

  it('reports an exhausted crash as failed, with what the session was', async () => {
    onLocation('remote');
    await startSession('s-crash');

    await emit('session:agent-exited', { sessionId: 's-crash', decision: 'failed' });

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

    await emit('session:agent-exited', { sessionId: 's-respawn', decision: 'respawnResume' });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('ends a session once, not once per way of ending', async () => {
    onLocation('local');
    await startSession('s-twice');
    await emit('session:agent-exited', { sessionId: 's-twice', decision: 'failed' });
    vi.mocked(trackEvent).mockClear();

    await emit('session:deleted', 's-twice');

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('reports a session this run never saw start as unknown', async () => {
    await emit('session:deleted', 's-from-a-previous-run');

    expect(trackEvent).toHaveBeenCalledWith('session_ended', {
      agent_type: 'unknown',
      location: 'unknown',
      outcome: 'normal',
    });
  });
});
