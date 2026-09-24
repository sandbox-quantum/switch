import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionLinks, SessionUnavailableError, serveParent } from './session-channel';

/** A child process as far as the parent's end can tell: messages both ways, and an exit. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    sent: unknown[];
    send: (message: unknown, callback: (error: Error | null) => void) => boolean;
  };
  child.sent = [];
  child.send = (message, callback) => {
    child.sent.push(message);
    callback(null);
    return true;
  };
  return child;
}

const event = (sequence: number) => ({
  contractVersion: 1,
  eventId: `event-${sequence}`,
  sessionId: 'session',
  sequence,
  occurredAt: '2026-09-24T12:00:00.000Z',
  body: { type: 'notice', level: 'info', code: 'X', message: 'hi' },
});

afterEach(() => vi.restoreAllMocks());

it('waits for the host to be ready, then gets its answer', async () => {
  const links = new SessionLinks();
  const child = fakeChild();
  links.attach('root', child as unknown as ChildProcess);
  const answer = links.request('root', { type: 'snapshot' }, 1000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(child.sent).toEqual([]);
  child.emit('message', { kind: 'ready' });
  await vi.waitFor(() => expect(child.sent).toHaveLength(1));
  const [request] = child.sent as { id: number }[];
  child.emit('message', { kind: 'reply', id: request!.id, ok: true, value: 'snapshot' });
  expect(await answer).toBe('snapshot');
});

it('refuses when no host comes, and when the host goes before answering', async () => {
  const links = new SessionLinks();
  await expect(links.request('nowhere', { type: 'snapshot' }, 20)).rejects.toThrow(
    SessionUnavailableError
  );
  const child = fakeChild();
  links.attach('root', child as unknown as ChildProcess);
  child.emit('message', { kind: 'ready' });
  const answer = links.request('root', { type: 'snapshot' }, 1000);
  await vi.waitFor(() => expect(child.sent).toHaveLength(1));
  child.emit('exit', 1, null);
  await expect(answer).rejects.toThrow('stopped before it answered');
  expect(links.ready('root')).toBe(false);
});

it('passes a refusal on as an error, and every pushed event to subscribers', async () => {
  const links = new SessionLinks();
  const heard: number[] = [];
  links.subscribe('root', (pushed) => heard.push(pushed.sequence));
  const child = fakeChild();
  links.attach('root', child as unknown as ChildProcess);
  child.emit('message', { kind: 'ready' });
  child.emit('message', { kind: 'event', event: event(1) });
  child.emit('message', { kind: 'event', event: event(2) });
  expect(heard).toEqual([1, 2]);
  const answer = links.request('root', { type: 'command', command: {} }, 1000);
  await vi.waitFor(() => expect(child.sent).toHaveLength(1));
  const [request] = child.sent as { id: number }[];
  child.emit('message', { kind: 'reply', id: request!.id, ok: false, error: 'STALE_EPOCH' });
  await expect(answer).rejects.toThrow('STALE_EPOCH');
});

it('serves requests on the host side when it has a parent', async () => {
  const sent: unknown[] = [];
  const port = Object.assign(new EventEmitter(), {
    connected: true,
    send: (message: unknown) => {
      sent.push(message);
      return true;
    },
  });
  const served = serveParent(
    {
      command: async () => ({ applied: true }),
      room: async () => null,
      snapshot: async () => 'snapshot',
      approvals: async () => null,
    },
    port
  );
  expect(served).not.toBeNull();
  served!.ready();
  served!.push(event(3) as never);
  port.emit('message', { kind: 'request', id: 7, request: { type: 'snapshot' } });
  port.emit('message', { kind: 'request', id: 8, request: { type: 'nonsense' } });
  await vi.waitFor(() =>
    expect(sent).toContainEqual({ kind: 'reply', id: 7, ok: true, value: 'snapshot' })
  );
  expect(sent.slice(0, 2)).toEqual([{ kind: 'ready' }, { kind: 'event', event: event(3) }]);
  expect(sent).toHaveLength(3);
  served!.close();
});

it('serves nothing without a parent', () => {
  const port = Object.assign(new EventEmitter(), { connected: false });
  expect(
    serveParent(
      {
        command: async () => null,
        room: async () => null,
        snapshot: async () => null,
        approvals: async () => null,
      },
      port
    )
  ).toBeNull();
});
