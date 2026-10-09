import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  connectParent,
  HOST_HUNG_UP_MS,
  SessionHostFailedError,
  SessionLinks,
  SessionUnavailableError,
} from './session-channel';

/** A child process as far as the parent's end can tell: messages both ways, and an exit. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    sent: unknown[];
    send: (message: unknown, callback: (error: Error | null) => void) => boolean;
  };
  child.sent = [];
  (child as unknown as { connected: boolean }).connected = true;
  Object.assign(child, { pid: 4242, exitCode: null, signalCode: null });
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
  child.emit('exit', null, 'SIGKILL');
  await expect(answer).rejects.toThrow('stopped before it answered');
  expect(links.ready('root')).toBe(false);
});

it('refuses a waiting request as soon as the host stops on a failure it recorded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-channel-'));
  try {
    await mkdir(join(root, 'supervisor'));
    const links = new SessionLinks();
    const failures: string[] = [];
    links.onFailure((failed, failure) => failures.push(`${failed === root}:${failure}`));
    const child = fakeChild();
    links.attach(root, child as unknown as ChildProcess);
    const started = Date.now();
    const answer = links.request(root, { type: 'snapshot' }, 60000);
    await writeFile(
      join(root, 'supervisor', 'failure.json'),
      JSON.stringify({ message: 'Sign in on the execution machine with claude auth login.' })
    );
    child.emit('exit', 1, null);
    await expect(answer).rejects.toThrow(SessionHostFailedError);
    await expect(answer).rejects.toMatchObject({
      failure: 'Sign in on the execution machine with claude auth login.',
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(failures).toEqual(['true:Sign in on the execution machine with claude auth login.']);
    // Asked again, it is refused at once rather than after the wait.
    await expect(links.request(root, { type: 'snapshot' }, 60000)).rejects.toThrow(
      SessionHostFailedError
    );
    expect(links.failure(root)).toBe('Sign in on the execution machine with claude auth login.');

    // Cleared once something starts it again, and by the next host.
    links.clearFailure(root);
    expect(links.failure(root)).toBeNull();
    const again = fakeChild();
    links.attach(root, again as unknown as ChildProcess);
    again.emit('exit', 3, null);
    expect(links.failure(root)).toBe('Sign in on the execution machine with claude auth login.');
    links.attach(root, fakeChild() as unknown as ChildProcess);
    expect(links.failure(root)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('says why when a failed host left no record of it', () => {
  const links = new SessionLinks();
  const child = fakeChild();
  links.attach('/nonexistent-session-root', child as unknown as ChildProcess);
  child.emit('exit', 2, null);
  expect(links.failure('/nonexistent-session-root')).toBe('The session host exited with code 2.');
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
  const answer = links.request('root', { type: 'command', command: {}, requesterName: null }, 1000);
  await vi.waitFor(() => expect(child.sent).toHaveLength(1));
  const [request] = child.sent as { id: number }[];
  child.emit('message', { kind: 'reply', id: request!.id, ok: false, error: 'STALE_EPOCH' });
  await expect(answer).rejects.toThrow('STALE_EPOCH');
});

function fakePort() {
  const sent: unknown[] = [];
  const port = Object.assign(new EventEmitter(), {
    connected: true,
    send: (message: unknown) => {
      sent.push(message);
      return true;
    },
  });
  return { sent, port };
}

it('serves requests on the host side once it has handlers', async () => {
  const { sent, port } = fakePort();
  const served = connectParent(port);
  port.emit('message', { kind: 'request', id: 6, request: { type: 'snapshot' } });
  expect(sent).toEqual([
    { kind: 'reply', id: 6, ok: false, error: 'The session host is not ready yet.' },
  ]);
  sent.length = 0;
  served.serve({
    command: async () => ({ applied: true }),
    room: async () => null,
    snapshot: async () => 'snapshot',
    approvals: async () => null,
    reasoning: async () => null,
  });
  served.ready();
  served.push(event(3) as never);
  port.emit('message', { kind: 'request', id: 7, request: { type: 'snapshot' } });
  port.emit('message', { kind: 'request', id: 8, request: { type: 'nonsense' } });
  await vi.waitFor(() =>
    expect(sent).toContainEqual({ kind: 'reply', id: 7, ok: true, value: 'snapshot' })
  );
  expect(sent.slice(0, 2)).toEqual([{ kind: 'ready' }, { kind: 'event', event: event(3) }]);
  expect(sent).toHaveLength(3);
  served.close();
  port.emit('message', { kind: 'request', id: 9, request: { type: 'snapshot' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(sent).toHaveLength(3);
});

it('refuses to serve without a parent', () => {
  const port = Object.assign(new EventEmitter(), { connected: false });
  expect(() => connectParent(port)).toThrow('has none');
});

const IDENTITY = { agentId: 'agent', sessionId: 'session', hostId: 'host', epoch: 'epoch' };

it("carries a host's question up to the watcher answering for its agent, and the answer back", async () => {
  const links = new SessionLinks();
  const child = fakeChild();
  links.attach('root', child as unknown as ChildProcess);
  const { port } = fakePort();
  // The host's end talks to the parent's end through the fake pipe both ways.
  port.send = (message: unknown) => {
    child.emit('message', message);
    return true;
  };
  child.send = (message, callback) => {
    port.emit('message', message);
    callback(null);
    return true;
  };
  const host = connectParent(port);
  host.identify(IDENTITY);
  expect(links.identity('root')).toEqual(IDENTITY);

  await expect(host.ask({ type: 'tools' })).rejects.toThrow('No room watcher is running');

  const handler = vi.fn(async (_caller: unknown, ask: { type: string }) =>
    ask.type === 'tools' ? [{ name: 'post_message' }] : { content: [] }
  );
  const release = links.answer('agent', handler);
  expect(() => links.answer('agent', handler)).toThrow('already has a watcher');
  expect(await host.ask({ type: 'tools' })).toEqual([{ name: 'post_message' }]);
  expect(await host.ask({ type: 'tool', name: 'post_message', arguments: { body: 'hi' } })).toEqual(
    {
      content: [],
    }
  );
  expect(handler).toHaveBeenLastCalledWith(
    { ...IDENTITY, root: 'root' },
    { type: 'tool', name: 'post_message', arguments: { body: 'hi' } }
  );

  handler.mockRejectedValueOnce(new Error('Switch refused'));
  await expect(host.ask({ type: 'tools' })).rejects.toThrow('Switch refused');

  release();
  await expect(host.ask({ type: 'tools' })).rejects.toThrow('No room watcher is running');
});

it('refuses a question from a host that has not said who it is, and tells who exited', async () => {
  const links = new SessionLinks();
  const child = fakeChild();
  links.attach('root', child as unknown as ChildProcess);
  links.answer('agent', async () => 'answered');
  child.emit('message', { kind: 'ask', id: 1, ask: { type: 'tools' } });
  await vi.waitFor(() =>
    expect(child.sent).toContainEqual({
      kind: 'answer',
      id: 1,
      ok: false,
      error: 'The session host asked its parent before saying which session it runs.',
    })
  );
  const exits: unknown[] = [];
  links.onExit((root, identity) => exits.push([root, identity]));
  child.emit('message', { kind: 'identity', identity: IDENTITY });
  child.emit('exit', 0, null);
  expect(exits).toEqual([['root', IDENTITY]]);
  expect(links.identity('root')).toBeNull();
});

it('keeps what a host last said about being busy, and answers a barrier once it has settled', async () => {
  const links = new SessionLinks();
  const child = fakeChild();
  const heard: string[] = [];
  links.onBusy((root) => heard.push(root));
  links.attach('root', child as unknown as ChildProcess);
  await expect(links.barrier('root', 100)).rejects.toThrow(SessionUnavailableError);
  child.emit('message', { kind: 'ready' });
  const running = { busy: true, reasons: [{ kind: 'turn_running', count: 1 }] };
  child.emit('message', { kind: 'busy', ...running });
  expect(links.busy('root')).toEqual(running);

  const answer = links.barrier('root', 1000);
  const [barrier] = child.sent as { kind: string; id: number }[];
  expect(barrier).toMatchObject({ kind: 'busyBarrier' });
  child.emit('message', { kind: 'busy', busy: false, reasons: [], barrier: barrier!.id });
  expect(await answer).toEqual({ busy: false, reasons: [] });

  const lost = links.barrier('root', 1000);
  child.emit('exit', 0, null);
  await expect(lost).rejects.toThrow(SessionUnavailableError);
  expect(links.busy('root')).toBeNull();
  expect(heard).toEqual(['root', 'root', 'root']);
});

it('answers a busy barrier on the host side with the settled state', async () => {
  const { sent, port } = fakePort();
  const served = connectParent(port);
  served.onBarrier(async () => ({ busy: true, reasons: [{ kind: 'approval_open', count: 2 }] }));
  served.busy({ busy: false, reasons: [] }, null);
  port.emit('message', { kind: 'busyBarrier', id: 4 });
  await vi.waitFor(() =>
    expect(sent).toEqual([
      { kind: 'busy', busy: false, reasons: [] },
      { kind: 'busy', busy: true, reasons: [{ kind: 'approval_open', count: 2 }], barrier: 4 },
    ])
  );
});

it('stops sending to a host that hung up, and waits for the next one', async () => {
  // A host that closed its pipe and did not exit — something it started still
  // running — used to read as ready for good, so every message went down a
  // closed pipe and failed, forever.
  const links = new SessionLinks();
  const hung = fakeChild();
  links.attach('root', hung as unknown as ChildProcess);
  hung.emit('message', { kind: 'ready' });
  const unanswered = links.request('root', { type: 'snapshot' }, 1000);
  await vi.waitFor(() => expect(hung.sent).toHaveLength(1));

  (hung as unknown as { connected: boolean }).connected = false;
  hung.emit('disconnect');

  await expect(unanswered).rejects.toThrow('hung up before it answered');
  expect(links.ready('root')).toBe(false);
  const next = links.request('root', { type: 'snapshot' }, 1000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(hung.sent).toHaveLength(1);

  const replacement = fakeChild();
  links.attach('root', replacement as unknown as ChildProcess);
  replacement.emit('message', { kind: 'ready' });
  await vi.waitFor(() => expect(replacement.sent).toHaveLength(1));
  const [request] = replacement.sent as { id: number }[];
  replacement.emit('message', { kind: 'reply', id: request!.id, ok: true, value: 'fresh' });
  expect(await next).toBe('fresh');
});

it('kills a host that hung up and stays alive, with what it started', async () => {
  vi.useFakeTimers();
  try {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const links = new SessionLinks();
    const hung = fakeChild();
    links.attach('root', hung as unknown as ChildProcess);
    hung.emit('disconnect');

    await vi.advanceTimersByTimeAsync(HOST_HUNG_UP_MS - 1);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // Its group: the provider it started is in it.
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
  } finally {
    vi.useRealTimers();
  }
});

it('leaves a host that hung up and then exited on its own', async () => {
  vi.useFakeTimers();
  try {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const links = new SessionLinks();
    const leaving = fakeChild();
    links.attach('root', leaving as unknown as ChildProcess);
    leaving.emit('disconnect');
    leaving.emit('exit', 0, null);

    await vi.advanceTimersByTimeAsync(HOST_HUNG_UP_MS * 2);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('tells a request waiting on a host that the host stopped, rather than at its deadline', async () => {
  const links = new SessionLinks();
  const child = fakeChild();
  links.attach('root', child as unknown as ChildProcess);
  const started = Date.now();
  const waiting = links.request('root', { type: 'snapshot' }, 60000);

  child.emit('exit', 0, null);

  await expect(waiting).rejects.toThrow('stopped before it was ready');
  expect(Date.now() - started).toBeLessThan(5000);
});

const REASONING = {
  epoch: 'epoch',
  turns: [
    {
      turnId: 'turn',
      text: 'thinking',
      startedAt: '2026-09-24T12:00:00.000Z',
      completedAt: '2026-09-24T12:00:03.000Z',
    },
  ],
};

it('asks a ready host for its reasoning, and asks nothing of a host that is not ready', async () => {
  const links = new SessionLinks();
  expect(await links.reasoning('nowhere', null)).toBeNull();
  const child = fakeChild();
  links.attach('root', child as unknown as ChildProcess);
  expect(await links.reasoning('root', null)).toBeNull();
  expect(child.sent).toEqual([]);
  child.emit('message', { kind: 'ready' });
  const answer = links.reasoning('root', ['turn']);
  await vi.waitFor(() => expect(child.sent).toHaveLength(1));
  const [request] = child.sent as { id: number; request: unknown }[];
  expect(request!.request).toEqual({ type: 'reasoning', turnIds: ['turn'] });
  child.emit('message', { kind: 'reply', id: request!.id, ok: true, value: REASONING });
  expect(await answer).toEqual(REASONING);
});

it('reads an unreadable or refused reasoning answer as none', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const links = new SessionLinks();
  const child = fakeChild();
  links.attach('root', child as unknown as ChildProcess);
  child.emit('message', { kind: 'ready' });
  const unreadable = links.reasoning('root', null);
  await vi.waitFor(() => expect(child.sent).toHaveLength(1));
  child.emit('message', { kind: 'reply', id: (child.sent[0] as { id: number }).id, ok: true });
  expect(await unreadable).toBeNull();
  const refused = links.reasoning('root', null);
  await vi.waitFor(() => expect(child.sent).toHaveLength(2));
  child.emit('message', {
    kind: 'reply',
    id: (child.sent[1] as { id: number }).id,
    ok: false,
    error: 'no',
  });
  expect(await refused).toBeNull();
});

it('stops asking a host that predates reasoning, and asks the next host again', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.useFakeTimers();
  try {
    const links = new SessionLinks();
    // An older host cannot parse the request, so it only warns and never answers.
    const child = fakeChild();
    links.attach('root', child as unknown as ChildProcess);
    child.emit('message', { kind: 'ready' });
    const answer = links.reasoning('root', null);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await answer).toBeNull();
    expect(child.sent).toHaveLength(1);
    expect(await links.reasoning('root', null)).toBeNull();
    expect(child.sent).toHaveLength(1);
    // The link still works for everything else.
    const snapshot = links.request('root', { type: 'snapshot' }, 1000);
    child.emit('message', {
      kind: 'reply',
      id: (child.sent[1] as { id: number }).id,
      ok: true,
      value: 's',
    });
    expect(await snapshot).toBe('s');

    const next = fakeChild();
    links.attach('root', next as unknown as ChildProcess);
    next.emit('message', { kind: 'ready' });
    const again = links.reasoning('root', null);
    await vi.waitFor(() => expect(next.sent).toHaveLength(1));
    next.emit('message', {
      kind: 'reply',
      id: (next.sent[0] as { id: number }).id,
      ok: true,
      value: REASONING,
    });
    expect(await again).toEqual(REASONING);
  } finally {
    vi.useRealTimers();
  }
});
