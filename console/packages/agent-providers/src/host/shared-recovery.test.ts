import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHostEvent } from '@switch-console/shared/session-v1';
import type { Command, HostEvent, Session, Snapshot } from '@switch-console/shared/session-v1';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderAdapter } from '../adapter';
import type { ProviderRuntimeEvent } from '../events';
import { SharedRoomInbox } from './room-inbox';
import { runSharedHost, SharedHostFencedError } from './shared-host';

vi.setConfig({ testTimeout: 30_000 });

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shared-recovery-'));
  roots.push(root);
  const session: Session = {
    sessionId: 'session',
    agentId: 'agent',
    hostId: 'host',
    epoch: 'proposed',
    provider: 'claude',
    status: 'starting',
    connectivity: 'online',
    pendingRequestIds: [],
    capabilities: {
      input: 'queue',
      approvals: true,
      questions: true,
      interrupt: true,
      reset: false,
      compact: false,
      modelChange: false,
      attachmentMimeTypes: [],
    },
  };
  let epoch = 'epoch-1';
  let live = false;
  let listener: (event: ProviderRuntimeEvent) => void = () => {};
  const emit = (body: Record<string, unknown>) =>
    listener({
      ...body,
      sessionId: 'session',
      provider: 'claude',
      eventId: randomUUID(),
      createdAt: new Date().toISOString(),
    } as ProviderRuntimeEvent);
  const adapter: ProviderAdapter = {
    provider: 'claude',
    capabilities: {
      resume: true,
      steering: false,
      approvals: true,
      userInput: true,
      modelSwitchInSession: false,
    },
    startSession: vi.fn(async () => {
      live = true;
      emit({ type: 'session.state.changed', status: 'ready' });
      return { provider: 'claude', sessionId: 'session', nativeSessionId: 'saved-native' };
    }),
    sendTurn: vi.fn(async ({ turnId }) => {
      emit({ type: 'turn.started', turnId });
      return { turnId };
    }),
    respondToRequest: vi.fn(async () => {}),
    respondToUserInput: vi.fn(async () => {}),
    interruptTurn: vi.fn(async () => {}),
    stopSession: vi.fn(async () => {
      live = false;
    }),
    stopAll: vi.fn(async () => {}),
    hasSession: () => live,
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = () => {};
      };
    },
  };
  const command: Command = {
    contractVersion: 1,
    commandId: 'turn',
    sessionId: 'session',
    epoch,
    origin: { actorId: 'owner', surface: 'console', roomId: null, threadId: null, messageId: null },
    body: { type: 'message.send', text: 'Once', attachments: [], delivery: 'queue' },
  };
  const events: HostEvent[] = [];
  let loseEventAck = true;
  let disconnect = false;
  let expired = false;
  const snapshot = (): Snapshot => ({
    contractVersion: 1,
    throughSequence: 1,
    session: { ...session, epoch },
    turns: [],
    items: [],
    requests: [],
    commandStatuses: [],
    nextPageToken: null,
  });
  const fetchMock = vi.fn(async (url: string, options: RequestInit) => {
    const path = new URL(url).pathname;
    if (disconnect) throw new TypeError('Temporary disconnect');
    if (path.endsWith('/claim')) return Response.json(snapshot());
    if (path.endsWith('/recover')) {
      epoch = 'epoch-2';
      return Response.json(snapshot());
    }
    if (expired && path.endsWith('/commands'))
      return Response.json({ code: 'HOST_OFFLINE' }, { status: 409 });
    if (path.endsWith('/commands')) return Response.json(epoch === 'epoch-1' ? [command] : []);
    if (path.endsWith('/events') || path.endsWith('/reconcile')) {
      const event = JSON.parse(options.body as string) as HostEvent;
      events.push(event);
      if (loseEventAck) {
        loseEventAck = false;
        throw new TypeError('Acknowledgement lost after commit');
      }
      return Response.json({ throughHostSequence: event.hostSequence });
    }
    return Response.json({ leaseSeconds: 30, quiesced: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    root,
    emit,
    command,
    adapter,
    events,
    fetchMock,
    setExpired: (value: boolean) => {
      expired = value;
    },
    setDisconnected: (value: boolean) => {
      disconnect = value;
    },
    options: {
      root,
      session,
      agentApiUrl: 'http://127.0.0.1/agent',
      token: randomUUID(),
      input: {
        sessionId: 'session',
        cwd: root,
        runtimeMode: 'approval-required' as const,
        env: {},
        mcpServers: {},
      },
    },
  };
}

it('retries lost acknowledgements and duplicate commands, then resumes the same native conversation', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'shared-recovery.lock'), '');
  let stop = new AbortController();
  let running = runSharedHost(f.options, f.adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(f.adapter.sendTurn).toHaveBeenCalledTimes(1), {
      timeout: 10_000,
    });
    f.setDisconnected(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(f.adapter.stopSession).not.toHaveBeenCalled();
    f.setDisconnected(false);
    await vi.waitFor(() =>
      expect(
        f.fetchMock.mock.calls.filter(([url]) => url.endsWith('/commands')).length
      ).toBeGreaterThan(1)
    );
  } finally {
    f.setDisconnected(false);
    stop.abort();
    await running;
  }
  expect(f.events[0]).toEqual(f.events[1]);
  expect(f.adapter.sendTurn).toHaveBeenCalledTimes(1);
  stop = new AbortController();
  // This in-process fake has no worker to exit; simulate supervisor reclamation.
  await unlink(join(f.root, 'shared-owner.lock'));
  running = runSharedHost(f.options, f.adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(f.adapter.startSession).toHaveBeenCalledTimes(2), {
      timeout: 10_000,
    });
    expect(f.adapter.startSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ resume: { nativeSessionId: 'saved-native' } })
    );
    await vi.waitFor(() =>
      expect(
        f.events.some(
          (event) =>
            event.epoch === 'epoch-2' &&
            event.body.type === 'turn.upsert' &&
            event.body.status === 'interrupted'
        )
      ).toBe(true)
    );
    expect(f.adapter.sendTurn).toHaveBeenCalledTimes(1);
  } finally {
    stop.abort();
    await running;
  }
});

it('refuses a crash owner whose provider execution has not been fenced', async () => {
  const f = await fixture();
  await writeFile(
    join(f.root, 'shared-owner.lock'),
    JSON.stringify({ pid: process.pid, group: null })
  );
  await expect(runSharedHost(f.options, f.adapter, new AbortController().signal)).rejects.toThrow(
    'FENCING_REQUIRED'
  );
  expect(f.adapter.startSession).not.toHaveBeenCalled();
  expect(f.fetchMock).not.toHaveBeenCalled();
});

it('stops an expired lease and resumes without repeating the accepted turn', async () => {
  const f = await fixture();
  const stop = new AbortController();
  const outcome = runSharedHost(f.options, f.adapter, stop.signal).catch((error) => error);
  await vi.waitFor(() => expect(f.adapter.sendTurn).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  f.setExpired(true);
  expect(await outcome).toMatchObject({ name: 'SharedHostLeaseExpiredError' });
  expect(f.adapter.stopSession).toHaveBeenCalledTimes(1);
  f.setExpired(false);
  await unlink(join(f.root, 'shared-owner.lock'));
  const resumed = runSharedHost(f.options, f.adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(f.adapter.startSession).toHaveBeenCalledTimes(2));
    expect(f.adapter.sendTurn).toHaveBeenCalledTimes(1);
  } finally {
    stop.abort();
    await resumed;
  }
});

it('resets under a server epoch despite a lost recovery acknowledgement', async () => {
  const f = await fixture();
  f.options.session.capabilities.reset = true;
  f.command.body = { type: 'session.reset' };
  f.command.commandId = 'reset';
  const original = f.fetchMock.getMockImplementation()!;
  let lost = false;
  f.fetchMock.mockImplementation(async (url, options) => {
    const response = await original(url, options);
    if (url.endsWith('/recover') && !lost) {
      lost = true;
      throw new TypeError('Lost epoch acknowledgement');
    }
    return response;
  });
  const stop = new AbortController();
  const running = runSharedHost(f.options, f.adapter, stop.signal);
  try {
    await vi.waitFor(
      () =>
        expect(
          f.events.some(
            (event) =>
              event.epoch === 'epoch-2' &&
              event.body.type === 'command.result' &&
              event.body.commandId === 'reset' &&
              event.body.status === 'applied'
          )
        ).toBe(true),
      { timeout: 10_000 }
    );
    expect(f.adapter.startSession).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.adapter.startSession).mock.calls[1][0].resume).toBeUndefined();
    const recoveries = f.fetchMock.mock.calls.filter(([url]) => url.endsWith('/recover'));
    expect(recoveries).toHaveLength(2);
    expect(recoveries[0][1].body).toBe(recoveries[1][1].body);
    expect(f.adapter.sendTurn).not.toHaveBeenCalled();
    const started = f.events.filter(
      (event) => event.body.type === 'session.upsert' && event.epoch === 'epoch-2'
    );
    expect(started.length).toBeGreaterThan(0);
    expect(
      started.every(
        (event) => event.body.type === 'session.upsert' && event.body.session.epoch === 'epoch-2'
      )
    ).toBe(true);
  } finally {
    stop.abort();
    await running;
  }
});

it('releases a faulted host instead of renewing its room claim forever', async () => {
  const f = await fixture();
  const result = runSharedHost(f.options, f.adapter, new AbortController().signal).catch(
    (error) => error
  );
  await vi.waitFor(() => expect(f.adapter.sendTurn).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  f.emit({ type: 'session.state.changed', status: 'error' });
  expect(await result).toMatchObject({ message: expect.stringContaining('HOST_FAULTED') });
  expect(f.adapter.stopSession).toHaveBeenCalledTimes(1);
  expect(f.fetchMock.mock.calls.some(([url]) => url.endsWith('/quiesce'))).toBe(true);
  expect(
    f.events.some(
      (event) => event.body.type === 'session.upsert' && event.body.session.status === 'error'
    )
  ).toBe(true);
});

it('bounds unavailable-server startup before any provider execution', async () => {
  const f = await fixture();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  f.fetchMock.mockImplementation(async () => {
    now = 31000;
    throw new TypeError('Unreachable');
  });
  await expect(runSharedHost(f.options, f.adapter, new AbortController().signal)).rejects.toThrow(
    'HOST_START_TIMEOUT'
  );
  expect(f.adapter.startSession).not.toHaveBeenCalled();
  expect(f.fetchMock).toHaveBeenCalledTimes(1);
});

it.each(['ROOM_EVENT_UNAVAILABLE', 'NOT_AUTHORIZED', 'ROOM_REPLAY_REFUSED'])(
  'acknowledges an unverifiable event with a visible notice: %s',
  async (code) => {
    const f = await fixture();
    await writeFile(
      join(f.root, 'room-inbox.jsonl'),
      JSON.stringify({ type: 'received', sequence: 1, roomId: 'room', messageId: 'message' }) + '\n'
    );
    vi.spyOn(SharedRoomInbox.prototype, 'connect').mockResolvedValue(undefined);
    const original = f.fetchMock.getMockImplementation()!;
    f.fetchMock.mockImplementation(async (url, options) => {
      if (url.endsWith('/room-failure')) return Response.json({});
      if (url.endsWith('/room-message'))
        return Response.json({ code, message: 'Room event cannot be verified' }, { status: 409 });
      return original(url, options);
    });
    const controller = new AbortController();
    const running = runSharedHost(
      { ...f.options, roomConnection: { connectionId: 'connection', rooms: ['room'] } },
      f.adapter,
      controller.signal
    );
    try {
      await vi.waitFor(
        async () =>
          expect(await SharedRoomInbox.readMessageState(f.root, 'room', 'message')).toBe(
            'acknowledged'
          ),
        { timeout: 5000 }
      );
      await vi.waitFor(
        () =>
          expect(
            f.events.some(
              (event) =>
                event.body.type === 'notice' && event.body.message.includes('Read the room context')
            )
          ).toBe(true),
        { timeout: 5000 }
      );
      expect(f.fetchMock.mock.calls.filter(([url]) => url.endsWith('/room-failure'))).toHaveLength(
        code === 'ROOM_EVENT_UNAVAILABLE' ? 1 : 0
      );
    } finally {
      controller.abort();
      await running;
    }
  }
);

it('reports a permanent startup failure to the bound room before exiting', async () => {
  const f = await fixture();
  await writeFile(
    join(f.root, 'room-inbox.jsonl'),
    JSON.stringify({ type: 'received', sequence: 1, roomId: 'room', messageId: 'message' }) + '\n'
  );
  vi.spyOn(SharedRoomInbox.prototype, 'connect').mockResolvedValue(undefined);
  vi.mocked(f.adapter.startSession).mockRejectedValue(new Error('Provider cannot start'));
  const original = f.fetchMock.getMockImplementation()!;
  f.fetchMock.mockImplementation(async (url, options) => {
    if (url.endsWith('/room-failure')) return Response.json({ rooms: ['room'] });
    return original(url, options);
  });
  await expect(
    runSharedHost(
      { ...f.options, roomConnection: { connectionId: 'connection', rooms: ['room'] } },
      f.adapter,
      new AbortController().signal
    )
  ).rejects.toThrow('Provider cannot start');
  const notices = f.fetchMock.mock.calls.filter(([url]) => url.endsWith('/room-failure'));
  expect(notices).toHaveLength(1);
  expect(JSON.parse(String(notices[0][1]?.body))).toEqual({
    host_id: 'host',
    epoch: 'epoch-1',
    connection_id: 'connection',
    room_id: 'room',
    message_id: 'message',
    reason: 'startup',
  });
  expect(f.adapter.sendTurn).not.toHaveBeenCalled();
});

it('holds room messages while a reset outcome is undecided and delivers them after the decision', async () => {
  const f = await fixture();
  f.options.session.capabilities.reset = true;
  const line = (value: unknown) => JSON.stringify(value) + '\n';
  await writeFile(
    join(f.root, 'shared-state.jsonl'),
    line({
      type: 'identity',
      session: f.options.session,
      apiUrl: 'http://127.0.0.1/agent',
      cwd: f.root,
      operationId: randomUUID(),
    }) +
      line({
        type: 'lease',
        sourceBase: 0,
        snapshot: {
          contractVersion: 1,
          throughSequence: 1,
          session: { ...f.options.session, epoch: 'epoch-1' },
          turns: [],
          items: [],
          requests: [],
          commandStatuses: [],
          nextPageToken: null,
        },
      })
  );
  await writeFile(
    join(f.root, 'events.jsonl'),
    line({
      contractVersion: 1,
      eventId: randomUUID(),
      sessionId: 'session',
      sequence: 1,
      occurredAt: new Date().toISOString(),
      body: {
        type: 'session.upsert',
        session: { ...f.options.session, epoch: 'epoch-1', status: 'ready' },
      },
    })
  );
  await writeFile(
    join(f.root, 'inbox.jsonl'),
    line({ type: 'native', nativeSessionId: 'saved-native' }) + line({ type: 'reset-started' })
  );
  await writeFile(
    join(f.root, 'room-inbox.jsonl'),
    line({ type: 'received', sequence: 1, roomId: 'room', messageId: 'message' })
  );
  vi.spyOn(SharedRoomInbox.prototype, 'connect').mockResolvedValue(undefined);
  const submitted: Array<{ messageId: string; announced: boolean }> = [];
  let decision: Command | null = null;
  const original = f.fetchMock.getMockImplementation()!;
  let recoveries = 0;
  f.fetchMock.mockImplementation(async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/recover')) {
      const response = await original(url, options);
      recoveries += 1;
      if (recoveries === 1) return response;
      const body = (await response.json()) as Snapshot;
      return Response.json({ ...body, session: { ...body.session, epoch: 'epoch-3' } });
    }
    if (path.endsWith('/room-failure')) return Response.json({});
    if (path.endsWith('/commands')) return Response.json(decision ? [decision] : []);
    if (path.endsWith('/room-message')) {
      submitted.push({
        messageId: JSON.parse(options.body as string).message_id,
        announced: f.events.some(
          (event) => event.body.type === 'notice' && event.body.code === 'ROOM_BACKLOG_DELIVERED'
        ),
      });
      return Response.json({
        type: 'command.status',
        commandId: 'room',
        status: 'applied',
        code: null,
        message: null,
      });
    }
    return original(url, options);
  });
  const stop = new AbortController();
  const running = runSharedHost(
    { ...f.options, roomConnection: { connectionId: 'connection', rooms: ['room'] } },
    f.adapter,
    stop.signal
  );
  try {
    await vi.waitFor(
      () =>
        expect(
          f.events.some(
            (event) => event.body.type === 'notice' && event.body.code === 'RESET_OUTCOME_UNKNOWN'
          )
        ).toBe(true),
      { timeout: 10_000 }
    );
    expect(f.adapter.startSession).not.toHaveBeenCalled();
    expect(f.adapter.stopSession).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(submitted).toEqual([]);
    const notices = f.fetchMock.mock.calls.filter(([url]) => url.endsWith('/room-failure'));
    expect(notices).toHaveLength(1);
    expect(JSON.parse(String(notices[0][1]?.body)).reason).toBe('conversation');
    decision = {
      ...f.command,
      commandId: 'decided-reset',
      epoch: 'epoch-2',
      body: { type: 'session.reset' },
    };
    await vi.waitFor(() => expect(submitted).toHaveLength(1), { timeout: 10_000 });
    expect(submitted[0]).toEqual({ messageId: 'message', announced: true });
    expect(f.adapter.startSession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.adapter.startSession).mock.calls[0][0].resume).toBeUndefined();
    expect(
      f.events.filter(
        (event) => event.body.type === 'notice' && event.body.code === 'ROOM_BACKLOG_DELIVERED'
      )
    ).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(submitted).toHaveLength(1);
  } finally {
    stop.abort();
    await running;
  }
});

it('reports a startup failure rather than the cleanup of an unstarted provider', async () => {
  const f = await fixture();
  vi.mocked(f.adapter.startSession).mockRejectedValue(new Error('Provider launch failed'));
  vi.mocked(f.adapter.stopSession).mockRejectedValue(new Error('Unknown session'));
  await expect(runSharedHost(f.options, f.adapter, new AbortController().signal)).rejects.toThrow(
    'Provider launch failed'
  );
  expect(f.adapter.stopSession).not.toHaveBeenCalled();
});

it('reconciles a journal whose saved state belongs to an earlier generation', async () => {
  const f = await fixture();
  const line = (value: unknown) => JSON.stringify(value) + '\n';
  await writeFile(
    join(f.root, 'shared-state.jsonl'),
    line({
      type: 'identity',
      session: f.options.session,
      apiUrl: 'http://127.0.0.1/agent',
      cwd: f.root,
      operationId: randomUUID(),
    }) +
      line({
        type: 'lease',
        sourceBase: 1,
        snapshot: {
          contractVersion: 1,
          throughSequence: 1,
          session: { ...f.options.session, epoch: 'epoch-1' },
          turns: [],
          items: [],
          requests: [],
          commandStatuses: [],
          nextPageToken: null,
        },
      })
  );
  await writeFile(
    join(f.root, 'events.jsonl'),
    line({
      contractVersion: 1,
      eventId: randomUUID(),
      sessionId: 'session',
      sequence: 2,
      occurredAt: new Date().toISOString(),
      body: {
        type: 'session.upsert',
        session: { ...f.options.session, epoch: 'epoch-0', status: 'error' },
      },
    })
  );
  await writeFile(
    join(f.root, 'inbox.jsonl'),
    line({ type: 'native', nativeSessionId: 'saved-native' })
  );
  const original = f.fetchMock.getMockImplementation()!;
  f.fetchMock.mockImplementation(async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/events') || path.endsWith('/reconcile'))
      try {
        parseHostEvent(JSON.parse(options.body as string));
      } catch (error) {
        return Response.json({ code: 'INVALID_EVENT', message: String(error) }, { status: 422 });
      }
    return original(url, options);
  });
  const stop = new AbortController();
  const running = runSharedHost(f.options, f.adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(f.adapter.startSession).toHaveBeenCalledTimes(1), {
      timeout: 10_000,
    });
    expect(
      f.events.some(
        (event) =>
          event.body.type === 'notice' && event.body.code === 'PRIOR_GENERATION_STATE_SKIPPED'
      )
    ).toBe(true);
    await vi.waitFor(() =>
      expect(
        f.events.some((event) => event.body.type === 'session.upsert' && event.epoch === 'epoch-2')
      ).toBe(true)
    );
  } finally {
    stop.abort();
    await running;
  }
});

it.each(['HOST_OFFLINE', 'STALE_EPOCH', 'HOST_NOT_OWNER'])(
  'retains input and exits when room submission is fenced: %s',
  async (code) => {
    const f = await fixture();
    await writeFile(
      join(f.root, 'room-inbox.jsonl'),
      JSON.stringify({ type: 'received', sequence: 1, roomId: 'room', messageId: 'message' }) + '\n'
    );
    vi.spyOn(SharedRoomInbox.prototype, 'connect').mockResolvedValue(undefined);
    const original = f.fetchMock.getMockImplementation()!;
    f.fetchMock.mockImplementation(async (url, options) =>
      url.endsWith('/room-message')
        ? Response.json({ code, message: 'Session is fenced' }, { status: 409 })
        : original(url, options)
    );
    await expect(
      runSharedHost(
        { ...f.options, roomConnection: { connectionId: 'connection', rooms: ['room'] } },
        f.adapter,
        new AbortController().signal
      )
    ).rejects.toThrow(code);
    expect(await SharedRoomInbox.readMessageState(f.root, 'room', 'message')).toBe('pending');
    expect(f.fetchMock.mock.calls.some(([url]) => url.endsWith('/room-failure'))).toBe(false);
    if (code === 'HOST_NOT_OWNER')
      expect(await readFile(join(f.root, 'inbox.jsonl'), 'utf8')).toContain('"type":"stopped"');
  }
);

it('keeps input pending until a transient delivery-notice failure recovers', async () => {
  const f = await fixture();
  await writeFile(
    join(f.root, 'room-inbox.jsonl'),
    JSON.stringify({ type: 'received', sequence: 1, roomId: 'room', messageId: 'message' }) + '\n'
  );
  vi.spyOn(SharedRoomInbox.prototype, 'connect').mockResolvedValue(undefined);
  const original = f.fetchMock.getMockImplementation()!;
  let notices = 0;
  let allowNotice = false;
  f.fetchMock.mockImplementation(async (url, options) => {
    if (url.endsWith('/room-message'))
      return Response.json({ code: 'ROOM_EVENT_UNAVAILABLE', message: 'Expired' }, { status: 409 });
    if (url.endsWith('/room-failure')) {
      notices++;
      return allowNotice ? Response.json({}) : new Response('', { status: 503 });
    }
    return original(url, options);
  });
  const stop = new AbortController();
  const running = runSharedHost(
    { ...f.options, roomConnection: { connectionId: 'connection', rooms: ['room'] } },
    f.adapter,
    stop.signal
  );
  try {
    await vi.waitFor(() => expect(notices).toBeGreaterThan(0));
    expect(await SharedRoomInbox.readMessageState(f.root, 'room', 'message')).toBe('pending');
    allowNotice = true;
    await vi.waitFor(
      async () =>
        expect(await SharedRoomInbox.readMessageState(f.root, 'room', 'message')).toBe(
          'acknowledged'
        ),
      { timeout: 5000 }
    );
    expect(notices).toBe(2);
    const localNotices = (await readFile(join(f.root, 'events.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (event) => event.body.type === 'notice' && event.body.message.includes('was not submitted')
      );
    expect(localNotices).toHaveLength(1);
  } finally {
    stop.abort();
    await running;
  }
});

it.each(['renew', 'stream'])(
  'fences ownership loss from %s while waiting between polls',
  async (source) => {
    const f = await fixture();
    let streamFailure: (error: Error) => void = () => {};
    vi.spyOn(SharedRoomInbox.prototype, 'connect').mockImplementation(async (_a, _b, _c, fail) => {
      streamFailure = fail;
    });
    const original = f.fetchMock.getMockImplementation()!;
    let takeover = false;
    f.fetchMock.mockImplementation(async (url, options) => {
      if (url.endsWith('/commands')) return Response.json([]);
      if (takeover && url.endsWith('/renew'))
        return Response.json({ code: 'HOST_NOT_OWNER', message: 'Host changed' }, { status: 409 });
      return original(url, options);
    });
    const running = runSharedHost(
      { ...f.options, roomConnection: { connectionId: 'connection', rooms: ['room'] } },
      f.adapter,
      new AbortController().signal
    );
    const failed = expect(running).rejects.toBeInstanceOf(SharedHostFencedError);
    await vi.waitFor(() =>
      expect(f.fetchMock.mock.calls.some(([url]) => url.endsWith('/commands'))).toBe(true)
    );
    if (source === 'stream')
      streamFailure(Object.assign(new Error('Host changed'), { code: 'HOST_NOT_OWNER' }));
    else takeover = true;
    await failed;
    expect(await readFile(join(f.root, 'inbox.jsonl'), 'utf8')).toContain('"type":"stopped"');
  }
);

it('retains pending identities and cleanup causes when fencing fails to stop the provider', async () => {
  const f = await fixture();
  await writeFile(
    join(f.root, 'room-inbox.jsonl'),
    JSON.stringify({ type: 'received', sequence: 1, roomId: 'room', messageId: 'held' }) + '\n'
  );
  vi.spyOn(SharedRoomInbox.prototype, 'connect').mockResolvedValue(undefined);
  const cleanup = new Error('Provider process did not exit');
  vi.mocked(f.adapter.stopSession).mockRejectedValue(cleanup);
  const original = f.fetchMock.getMockImplementation()!;
  f.fetchMock.mockImplementation(async (url, options) =>
    url.endsWith('/room-message')
      ? Response.json({ code: 'HOST_NOT_OWNER', message: 'Host changed' }, { status: 409 })
      : original(url, options)
  );
  const failure = await runSharedHost(
    { ...f.options, roomConnection: { connectionId: 'connection', rooms: ['room'] } },
    f.adapter,
    new AbortController().signal
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(SharedHostFencedError);
  expect(failure).toMatchObject({
    message: expect.stringContaining('Stop and start the agent'),
    pendingMessages: [{ roomId: 'room', messageId: 'held' }],
    cause: expect.any(AggregateError),
  });
  expect((failure as Error).cause).toMatchObject({ errors: expect.arrayContaining([cleanup]) });
});

it('fences a stream takeover when startup finishes without entering the poll loop', async () => {
  const f = await fixture();
  let streamFailure: (error: Error) => void = () => {};
  vi.spyOn(SharedRoomInbox.prototype, 'connect').mockImplementation(async (_a, _b, _c, fail) => {
    streamFailure = fail;
  });
  f.adapter.listModels = vi.fn(async () => {
    streamFailure(Object.assign(new Error('Host changed'), { code: 'HOST_NOT_OWNER' }));
    return [];
  });
  await expect(
    runSharedHost(
      { ...f.options, roomConnection: { connectionId: 'connection', rooms: ['room'] } },
      f.adapter,
      new AbortController().signal
    )
  ).rejects.toBeInstanceOf(SharedHostFencedError);
  expect(await readFile(join(f.root, 'inbox.jsonl'), 'utf8')).toContain('"type":"stopped"');
});
