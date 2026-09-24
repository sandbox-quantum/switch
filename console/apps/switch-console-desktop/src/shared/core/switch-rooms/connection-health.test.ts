import { describe, expect, it } from 'vitest';
import {
  CONNECTION_GRACE_MS,
  classifyWatcher,
  connectionNeedsAttention,
  type WatcherReport,
} from './connection-health';

const watcher = (state: Extract<WatcherReport, { kind: 'watcher' }>['state'], detail = null) =>
  ({ kind: 'watcher', state, detail, since: 1000 }) as WatcherReport;

describe('room connection health', () => {
  it('shows what the watcher says about its own connection', () => {
    const at = { stopped: false, now: 1000 };
    expect(classifyWatcher({ ...at, report: watcher('connected') }).state).toBe('connected');
    expect(classifyWatcher({ ...at, report: watcher('connecting') }).state).toBe('connecting');
    expect(classifyWatcher({ ...at, report: watcher('disabled') }).state).toBe('stopped');
    expect(
      classifyWatcher({
        ...at,
        report: { kind: 'watcher', state: 'taken-over', detail: 'elsewhere', since: 0 },
      })
    ).toEqual({ state: 'taken-over', detail: 'elsewhere', graceUntil: null });
  });

  it('gives a dropped stream time to come back before calling it failed', () => {
    const report: WatcherReport = {
      kind: 'watcher',
      state: 'disconnected',
      detail: 'HTTP 502',
      since: 1000,
    };
    expect(classifyWatcher({ stopped: false, report, now: 2000 })).toEqual({
      state: 'connecting',
      detail: 'HTTP 502',
      graceUntil: 1000 + CONNECTION_GRACE_MS,
    });
    expect(classifyWatcher({ stopped: false, report, now: 1000 + CONNECTION_GRACE_MS })).toEqual({
      state: 'failed',
      detail: 'HTTP 502',
      graceUntil: null,
    });
  });

  it('calls a watcher that stopped on an error failed at once', () => {
    expect(
      classifyWatcher({
        stopped: false,
        report: { kind: 'watcher', state: 'not-running', detail: 'boom', since: 1000 },
        now: 1000,
      })
    ).toEqual({ state: 'failed', detail: 'boom', graceUntil: null });
    expect(
      classifyWatcher({
        stopped: false,
        report: watcher('not-running'),
        now: 1000 + CONNECTION_GRACE_MS,
      })
    ).toMatchObject({ state: 'failed', detail: expect.stringContaining('not running') });
  });

  it('says a sidecar could not be reached rather than calling it disconnected', () => {
    expect(
      classifyWatcher({
        stopped: false,
        report: { kind: 'unreachable', detail: 'ssh: no route', takenOver: null },
        now: 0,
      })
    ).toEqual({ state: 'unreachable', detail: 'ssh: no route', graceUntil: null });
    expect(
      classifyWatcher({
        stopped: false,
        report: { kind: 'unreachable', detail: 'not running', takenOver: 'another client' },
        now: 0,
      }).state
    ).toBe('taken-over');
    expect(connectionNeedsAttention('unreachable')).toBe(true);
  });

  it('keeps deliberate stops distinct from crashes', () => {
    expect(classifyWatcher({ stopped: true, report: watcher('not-running'), now: 0 }).state).toBe(
      'stopped'
    );
    expect(connectionNeedsAttention('stopped')).toBe(false);
    expect(connectionNeedsAttention('taken-over')).toBe(true);
  });
});
