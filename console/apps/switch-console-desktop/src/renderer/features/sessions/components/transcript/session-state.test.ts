import { expect, it } from 'vitest';
import { sessionStatePill } from './session-state';

const base = {
  action: null,
  elapsedSeconds: 0,
  failed: false,
  retired: false,
  status: 'ready',
  connectivity: 'online' as const,
  reachable: true,
};

it('shows the session status when the host is reachable', () => {
  expect(sessionStatePill(base)).toEqual({ label: 'ready', tone: 'ready' });
  expect(sessionStatePill({ ...base, status: 'running' })).toEqual({
    label: 'running',
    tone: 'ready',
  });
});

// Status and reachability used to sit at opposite ends of the header. A session
// cannot be meaningfully "ready" on a host Console cannot reach, so the pill
// reports the reachability instead of a status that is no longer true.
it('reports unreachability rather than a status it cannot stand behind', () => {
  expect(sessionStatePill({ ...base, reachable: false, connectivity: 'offline' })).toEqual({
    label: 'offline',
    tone: 'bad',
  });
});

it('counts up while Console is acting on the session', () => {
  expect(sessionStatePill({ ...base, action: 'restart', elapsedSeconds: 7 })).toEqual({
    label: 'restarting 7s',
    tone: 'busy',
  });
});

it('keeps a finished session distinct from a broken one', () => {
  expect(sessionStatePill({ ...base, status: 'stopped', reachable: false })).toEqual({
    label: 'stopped',
    tone: 'idle',
  });
  expect(sessionStatePill({ ...base, retired: true })).toEqual({ label: 'retired', tone: 'idle' });
  expect(sessionStatePill({ ...base, failed: true })).toEqual({
    label: 'connection failed',
    tone: 'bad',
  });
  expect(sessionStatePill({ ...base, status: 'error' })).toEqual({ label: 'error', tone: 'bad' });
});

it('says it is connecting while the host comes up', () => {
  expect(sessionStatePill({ ...base, status: 'starting', reachable: false })).toEqual({
    label: 'connecting…',
    tone: 'busy',
  });
});
