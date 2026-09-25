import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { sharedSessionRoot } from '@switch-console/agent-providers';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ runtime: vi.fn(), emit: vi.fn() }));
vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));
vi.mock('@main/core/sessions/session-runtime-manager', () => ({
  sessionRuntimeManager: { getAgent: mocks.runtime },
}));
vi.mock('./local-host', async () => {
  const { SessionLinks } = await import('@switch-console/agent-providers');
  return { localSessionLinks: new SessionLinks() };
});

const { recordRemoteHostFailure, sessionIssue, sessionStartupStatus } =
  await import('./host-failures');
const { localSessionLinks } = await import('./local-host');

beforeEach(() => {
  mocks.runtime.mockReset();
  mocks.emit.mockReset();
  mocks.runtime.mockReturnValue(undefined);
});

it('shows a session the watcher started as failed once its local host stops on a failure', () => {
  expect(sessionStartupStatus('local-session')).toBeNull();
  const child = new EventEmitter();
  localSessionLinks.attach(sharedSessionRoot('local-session'), child as unknown as ChildProcess);
  child.emit('exit', 1, null);
  expect(sessionStartupStatus('local-session')).toEqual({
    status: 'error',
    message: expect.stringMatching(/^Shared SDK host failed: /),
  });
  // Started again, it is no longer shown as failed.
  localSessionLinks.attach(sharedSessionRoot('local-session'), new EventEmitter() as never);
  expect(sessionStartupStatus('local-session')).toBeNull();
});

it('shows the failure the sidecar pushed for a remote session until a host comes up again', () => {
  recordRemoteHostFailure('remote-session', 'Sign in on the execution machine with codex login.');
  expect(sessionStartupStatus('remote-session')).toEqual({
    status: 'error',
    message: 'Shared SDK host failed: Sign in on the execution machine with codex login.',
  });
  recordRemoteHostFailure('remote-session', null);
  expect(sessionStartupStatus('remote-session')).toBeNull();
});

it('leaves Console’s own start in charge while it runs', () => {
  recordRemoteHostFailure('starting-session', 'An earlier failure.');
  mocks.runtime.mockReturnValue({
    startupStatus: () => ({ status: 'starting', message: 'Starting the session process…' }),
  });
  expect(sessionStartupStatus('starting-session')).toEqual({
    status: 'starting',
    message: 'Starting the session process…',
  });
  mocks.runtime.mockReturnValue({ startupStatus: () => ({ status: 'ready', message: null }) });
  expect(sessionStartupStatus('starting-session')).toEqual({
    status: 'error',
    message: 'Shared SDK host failed: An earlier failure.',
  });
});

it('tells the sidebar when a session it asked about fails or comes back', () => {
  expect(sessionIssue('watched-session')).toBeNull();
  const child = new EventEmitter();
  localSessionLinks.attach(sharedSessionRoot('watched-session'), child as unknown as ChildProcess);
  child.emit('exit', 1, null);
  expect(mocks.emit).toHaveBeenCalledWith(
    expect.anything(),
    { sessionId: 'watched-session' },
    'watched-session'
  );
  expect(sessionIssue('watched-session')).toMatch(/^Shared SDK host failed: /);

  mocks.emit.mockReset();
  recordRemoteHostFailure('remote-watched', 'Not signed in.');
  recordRemoteHostFailure('remote-watched', 'Not signed in.');
  expect(mocks.emit).toHaveBeenCalledTimes(1);
  expect(sessionIssue('remote-watched')).toMatch(/Not signed in\.$/);
});
