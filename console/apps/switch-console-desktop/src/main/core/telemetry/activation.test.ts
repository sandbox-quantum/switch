import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelemetryEvent, TelemetryInstallKind } from './events';

/**
 * The activation milestones: which sent events mark them, that each is
 * reported once for the life of an install, and only by an install that began
 * on a version reporting them.
 *
 * Each test loads the module afresh, as a new launch would, over records that
 * outlive it the way the database does.
 */

const { records, launch, unwritable } = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  launch: { kind: 'new' as TelemetryInstallKind | 'unknown' },
  unwritable: { on: false },
}));

vi.mock('@main/db/kv', () => ({
  KV: class {
    async get(key: string) {
      return records.get(key) ?? null;
    }
    async setOrThrow(key: string, value: unknown) {
      if (unwritable.on) throw new Error('kv: write failed');
      records.set(key, value);
    }
  },
}));
vi.mock('./launch-history', () => ({ launchInstallKind: async () => launch.kind }));
vi.mock('./telemetry-service', () => ({
  trackEvent: vi.fn(),
  telemetryService: { setSentListener: vi.fn() },
}));
vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A launch of the app: the module as it loads, with nothing in memory. */
async function launchApp() {
  vi.resetModules();
  vi.clearAllMocks();
  const activation = await import('./activation');
  const { trackEvent } = await import('./telemetry-service');
  const { log } = await import('@main/lib/logger');
  return { ...activation, trackEvent: vi.mocked(trackEvent), log: vi.mocked(log) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const SIGNED_IN: TelemetryEvent = {
  name: 'server_sign_in',
  properties: {
    auth_method: 'password',
    server_kind: 'external',
    outcome: 'success',
    failure_reason: 'none',
  },
};
const AGENT_CREATED: TelemetryEvent = {
  name: 'agent_created',
  properties: {
    agent_type: 'claude',
    location: 'local',
    outcome: 'success',
    failure_reason: 'none',
    entry_point: 'onboarding',
  },
};
const MANAGED_SESSION: TelemetryEvent = {
  name: 'managed_session_started',
  properties: { agent_type: 'claude', start_source: 'room' },
};

beforeEach(() => {
  records.clear();
  launch.kind = 'new';
  unwritable.on = false;
});

describe('which events mark a milestone', () => {
  it('names the milestone each successful step marks, and nothing for the rest', async () => {
    const { milestoneOf } = await launchApp();
    const failedSignIn: TelemetryEvent = {
      name: 'server_sign_in',
      properties: { ...SIGNED_IN.properties, outcome: 'failure', failure_reason: 'failed' },
    } as TelemetryEvent;
    const managedStart = (action: 'start' | 'stop', outcome: 'success' | 'failure') =>
      ({
        name: 'managed_server_action',
        properties: {
          action,
          target: 'local',
          outcome,
          failure_reason: outcome === 'success' ? 'none' : 'error',
          docker_available: 'available',
        },
      }) as TelemetryEvent;

    expect(milestoneOf(SIGNED_IN)).toBe('server_ready');
    expect(milestoneOf(failedSignIn)).toBeNull();
    expect(milestoneOf(managedStart('start', 'success'))).toBe('server_ready');
    expect(milestoneOf(managedStart('start', 'failure'))).toBeNull();
    expect(milestoneOf(managedStart('stop', 'success'))).toBeNull();
    expect(milestoneOf(AGENT_CREATED)).toBe('agent_ready');
    expect(
      milestoneOf({
        name: 'session_started',
        properties: {
          agent_type: 'codex',
          location: 'remote',
          outcome: 'success',
          failure_reason: 'none',
          entry_point: 'session_list',
          start_source: 'user',
          has_initial_prompt: false,
          connected_to_room: false,
        },
      })
    ).toBe('first_agent_session');
    expect(milestoneOf(MANAGED_SESSION)).toBe('first_agent_session');
    expect(milestoneOf({ name: 'app_launched', properties: { install_kind: 'new' } })).toBeNull();
  });
});

describe('a new install', () => {
  it('reports each milestone once, even across launches', async () => {
    const first = await launchApp();
    first.noteSentEvent(SIGNED_IN);
    first.noteSentEvent(SIGNED_IN);
    first.noteSentEvent(AGENT_CREATED);
    await settle();
    expect(first.trackEvent.mock.calls).toEqual([
      ['activation_milestone', { milestone: 'server_ready', path: 'unknown' }],
      ['activation_milestone', { milestone: 'agent_ready', path: 'unknown' }],
    ]);

    launch.kind = 'same';
    const second = await launchApp();
    second.noteSentEvent(SIGNED_IN);
    second.noteSentEvent(MANAGED_SESSION);
    await settle();
    expect(second.trackEvent.mock.calls).toEqual([
      ['activation_milestone', { milestone: 'first_agent_session', path: 'unknown' }],
    ]);
  });

  it('carries the way it went at Meet switch-buddy, the first answer standing', async () => {
    const app = await launchApp();
    app.noteSentEvent(SIGNED_IN);
    await settle();
    app.noteBuddyStep('skip');
    app.noteBuddyStep('start');
    app.noteSentEvent(AGENT_CREATED);
    await settle();
    expect(app.trackEvent.mock.calls).toEqual([
      ['activation_milestone', { milestone: 'server_ready', path: 'unknown' }],
      ['activation_milestone', { milestone: 'agent_ready', path: 'manual' }],
    ]);

    launch.kind = 'same';
    const later = await launchApp();
    later.noteBuddyStep('start');
    later.noteSentEvent(MANAGED_SESSION);
    await settle();
    expect(later.trackEvent).toHaveBeenCalledWith('activation_milestone', {
      milestone: 'first_agent_session',
      path: 'manual',
    });
  });

  it('knows the buddy was started even when its agent is created before that is stored', async () => {
    const app = await launchApp();
    app.noteBuddyStep('start');
    app.noteSentEvent(AGENT_CREATED);
    await settle();
    expect(app.trackEvent).toHaveBeenCalledWith('activation_milestone', {
      milestone: 'agent_ready',
      path: 'buddy',
    });
  });

  it('is decided on its first launch, before it reaches anything', async () => {
    const first = await launchApp();
    await first.activationTracked();

    launch.kind = 'same';
    const second = await launchApp();
    second.noteSentEvent(AGENT_CREATED);
    await settle();
    expect(second.trackEvent).toHaveBeenCalledWith('activation_milestone', {
      milestone: 'agent_ready',
      path: 'unknown',
    });
  });
});

describe('an install that existed before', () => {
  it('reports no milestone, on this launch or any later one', async () => {
    launch.kind = 'updated';
    const first = await launchApp();
    first.noteSentEvent(SIGNED_IN);
    await settle();
    expect(first.trackEvent).not.toHaveBeenCalled();

    launch.kind = 'same';
    const second = await launchApp();
    second.noteSentEvent(AGENT_CREATED);
    second.noteSentEvent(MANAGED_SESSION);
    await settle();
    expect(second.trackEvent).not.toHaveBeenCalled();
  });
});

describe('when the records fail', () => {
  it('decides nothing on a launch that could not be recorded', async () => {
    launch.kind = 'unknown';
    const app = await launchApp();
    app.noteSentEvent(SIGNED_IN);
    await settle();
    expect(app.trackEvent).not.toHaveBeenCalled();
    expect(records.has('tracked')).toBe(false);
  });

  it('sends nothing it could not record, and says so', async () => {
    const app = await launchApp();
    await app.activationTracked();
    unwritable.on = true;
    app.noteSentEvent(SIGNED_IN);
    await settle();
    expect(app.trackEvent).not.toHaveBeenCalled();
    expect(app.log.warn).toHaveBeenCalledWith(
      'telemetry: could not record an activation milestone, so it is not sent',
      expect.objectContaining({ milestone: 'server_ready' })
    );
  });
});
