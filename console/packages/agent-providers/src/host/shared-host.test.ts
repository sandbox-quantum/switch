import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command, HostEvent, Session } from '@switch-console/shared/session-v1';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderAdapter } from '../adapter';
import type { ProviderRuntimeEvent } from '../events';
import { declareHandoffCapability, handOff, readsHandoffs, wakeCommands } from './handoff';
import { runSharedHost, SharedHostUnavailableError } from './shared-host';

/** Every answer Switch has given this session's room binding, in order. */
async function boundRooms(root: string): Promise<string[][]> {
  const text = await readFile(join(root, 'room-inbox.jsonl'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .slice(0, -1)
    .map((line) => JSON.parse(line) as { type: string; rooms?: string[] })
    .filter((record) => record.type === 'rooms')
    .map((record) => record.rooms!);
}

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('executes server commands and uploads cancellation without server-owned events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-host-test-'));
  roots.push(root);
  const stop = new AbortController();
  const events: HostEvent[] = [];
  const issued = new Set<string>();
  let listener: (event: ProviderRuntimeEvent) => void = () => {};
  let live = false;
  const emit = (event: Record<string, unknown>) =>
    listener({
      ...event,
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
      return { provider: 'claude', sessionId: 'session', nativeSessionId: 'native' };
    }),
    sendTurn: vi.fn(async ({ turnId }) => {
      emit({ type: 'turn.started', turnId });
      emit({
        type: 'request.opened',
        turnId,
        requestId: 'permission',
        requestType: 'tool_approval',
        title: 'Write file',
        options: [{ decision: 'cancel', label: 'Cancel' }],
      });
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
      interrupt: false,
      reset: false,
      compact: false,
      modelChange: false,
      attachmentMimeTypes: [],
    },
  };
  const command = (id: string, body: Command['body']): Command => ({
    contractVersion: 1,
    commandId: id,
    sessionId: 'session',
    epoch: 'server-epoch',
    origin: {
      actorId: 'verified-owner',
      surface: 'slack',
      roomId: 'room',
      threadId: null,
      messageId: 'card',
    },
    body,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      let result: unknown;
      if (path.endsWith('/claim'))
        result = {
          contractVersion: 1,
          throughSequence: 1,
          session: { ...session, epoch: 'server-epoch' },
          turns: [],
          items: [],
          requests: [],
          commandStatuses: [],
          nextPageToken: null,
        };
      else if (path.endsWith('/events')) {
        const event = JSON.parse(options.body as string) as HostEvent;
        events.push(event);
        result = { throughHostSequence: event.hostSequence };
      } else if (path.endsWith('/commands')) {
        if (
          !issued.has('turn') &&
          events.some(
            (event) => event.body.type === 'session.upsert' && event.body.session.status === 'ready'
          )
        ) {
          issued.add('turn');
          result = [
            command('turn', {
              type: 'message.send',
              delivery: 'queue',
              text: 'Hello',
              attachments: [],
            }),
          ];
        } else if (
          events.some((event) => event.body.type === 'request.opened') &&
          !issued.has('answer')
        ) {
          issued.add('answer');
          result = [
            command('answer', {
              type: 'request.answer',
              requestId: 'permission',
              expectedRevision: 1,
              answer: { kind: 'approval', optionId: '0' },
            }),
          ];
        } else result = [];
      } else result = { leaseSeconds: 30 };
      return Response.json(result);
    })
  );
  const running = runSharedHost(
    {
      root: join(root, 'session'),
      agentApiUrl: 'http://127.0.0.1/agent',
      token: randomUUID(),
      session,
      input: {
        sessionId: 'session',
        cwd: root,
        runtimeMode: 'approval-required',
        env: {},
        mcpServers: {},
      },
    },
    adapter,
    stop.signal
  );
  const outcome = running.then(
    () => null,
    (error: unknown) => error
  );
  try {
    await vi.waitFor(
      () =>
        expect(
          events.some(
            (event) => event.body.type === 'command.result' && event.body.commandId === 'answer'
          )
        ).toBe(true),
      { timeout: 3000 }
    );
    expect(adapter.respondToRequest).toHaveBeenCalledExactlyOnceWith(
      'session',
      'permission',
      'cancel'
    );
    expect(events.map((event) => event.hostSequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.every((event) => event.epoch === 'server-epoch')).toBe(true);
    expect(events.find((event) => event.body.type === 'request.settled')?.body).toMatchObject({
      outcome: 'cancelled',
      result: null,
      commandId: 'answer',
    });
    expect(
      events.some((event) => ['request.submitting', 'command.status'].includes(event.body.type))
    ).toBe(false);
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
  expect(adapter.stopSession).toHaveBeenCalled();
});

it('runs a room message handed back by its admission, and not again when it is re-offered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-host-room-'));
  roots.push(root);
  await writeFile(
    join(root, 'room-inbox.jsonl'),
    JSON.stringify({ type: 'received', sequence: 1, roomId: 'room', messageId: 'message' }) + '\n'
  );
  const stop = new AbortController();
  let listener: (event: ProviderRuntimeEvent) => void = () => {};
  let live = false;
  let ranBeforeAnyFetchCouldSupplyIt: boolean | null = null;
  let offeredByFetch = false;
  const emit = (event: Record<string, unknown>) =>
    listener({
      ...event,
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
      return { provider: 'claude', sessionId: 'session', nativeSessionId: 'native' };
    }),
    sendTurn: vi.fn(async ({ turnId }) => {
      ranBeforeAnyFetchCouldSupplyIt ??= !offeredByFetch;
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
      interrupt: false,
      reset: false,
      compact: false,
      modelChange: false,
      attachmentMimeTypes: [],
    },
  };
  const roomCommand: Command = {
    contractVersion: 1,
    commandId: 'room-command',
    sessionId: 'session',
    epoch: 'server-epoch',
    origin: {
      actorId: '@owner:example.test',
      surface: 'slack',
      roomId: 'room',
      threadId: null,
      messageId: 'message',
    },
    body: { type: 'message.send', delivery: 'queue', text: 'Run the check', attachments: [] },
  };
  let admissions = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/claim'))
        return Response.json({
          contractVersion: 1,
          throughSequence: 1,
          session: { ...session, epoch: 'server-epoch' },
          turns: [],
          items: [],
          requests: [],
          commandStatuses: [],
          nextPageToken: null,
        });
      if (path.endsWith('/events')) {
        const event = JSON.parse(options.body as string) as HostEvent;
        return Response.json({ throughHostSequence: event.hostSequence });
      }
      if (path.endsWith('/room-message')) {
        admissions += 1;
        // Asked for in the query string, because a server built before this
        // existed rejects an unknown field in the body and ignores an unknown
        // parameter here.
        expect(new URL(url).searchParams.get('include_command')).toBe('true');
        const sent = JSON.parse(options.body as string) as Record<string, unknown>;
        expect(sent).toMatchObject({ message_id: 'message' });
        expect(sent).not.toHaveProperty('include_command');
        return Response.json({
          type: 'command.status',
          commandId: roomCommand.commandId,
          status: 'accepted',
          code: null,
          message: null,
          command: roomCommand,
        });
      }
      if (path.endsWith('/commands')) {
        // Switch holds a command open until its result is reported, so every
        // fetch after the admission offers the very same one again.
        if (admissions === 0) return Response.json([]);
        offeredByFetch = true;
        return Response.json([roomCommand]);
      }
      if (path.endsWith('/room-connection')) return Response.json({ rooms: ['room'] });
      if (path.endsWith('/room-reservations')) return Response.json([]);
      return Response.json({ leaseSeconds: 30 });
    })
  );
  const running = runSharedHost(
    {
      root,
      agentApiUrl: 'http://127.0.0.1/agent',
      token: randomUUID(),
      session,
      input: {
        sessionId: 'session',
        cwd: root,
        runtimeMode: 'approval-required',
        env: {},
        mcpServers: {},
      },
      roomConnection: { connectionId: 'connection' },
    },
    adapter,
    stop.signal
  );
  const outcome = running.then(
    () => null,
    (error: unknown) => error
  );
  try {
    await vi.waitFor(() => expect(adapter.sendTurn).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(ranBeforeAnyFetchCouldSupplyIt).toBe(true);
    await vi.waitFor(() => expect(offeredByFetch).toBe(true), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(adapter.sendTurn).toHaveBeenCalledTimes(1);
    expect(admissions).toBe(1);
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
});

function roomWorker() {
  let listener: (event: ProviderRuntimeEvent) => void = () => {};
  let live = false;
  const ran: string[] = [];
  const emit = (event: Record<string, unknown>) =>
    listener({
      ...event,
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
      return { provider: 'claude', sessionId: 'session', nativeSessionId: 'native' };
    }),
    sendTurn: vi.fn(async ({ turnId, text }) => {
      ran.push(text);
      emit({ type: 'turn.started', turnId });
      emit({ type: 'turn.completed', turnId, outcome: 'completed' });
      return { turnId };
    }),
    respondToRequest: vi.fn(async () => {}),
    respondToUserInput: vi.fn(async () => {}),
    interruptTurn: vi.fn(async () => {}),
    stopSession: vi.fn(async () => {
      live = false;
      emit({ type: 'session.exited', reason: 'Stopped' });
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
  return { adapter, ran, emit };
}

const startingSession: Session = {
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
    interrupt: false,
    reset: false,
    compact: false,
    modelChange: false,
    attachmentMimeTypes: [],
  },
};

/** Admits whatever it is given and hands the command back in the same response. */
function admittingServer() {
  const admitted: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/claim'))
        return Response.json({
          contractVersion: 1,
          throughSequence: 1,
          session: { ...startingSession, epoch: 'server-epoch' },
          turns: [],
          items: [],
          requests: [],
          commandStatuses: [],
          nextPageToken: null,
        });
      if (path.endsWith('/events')) {
        const event = JSON.parse(options.body as string) as HostEvent;
        return Response.json({ throughHostSequence: event.hostSequence });
      }
      if (path.endsWith('/room-message')) {
        const { message_id: messageId } = JSON.parse(options.body as string) as {
          message_id: string;
        };
        admitted.push(messageId);
        return Response.json({
          type: 'command.status',
          commandId: `command-${messageId}`,
          status: 'accepted',
          code: null,
          message: null,
          command: {
            contractVersion: 1,
            commandId: `command-${messageId}`,
            sessionId: 'session',
            epoch: 'server-epoch',
            origin: {
              actorId: '@owner:example.test',
              surface: 'slack',
              roomId: 'room',
              threadId: null,
              messageId,
            },
            body: { type: 'message.send', delivery: 'queue', text: messageId, attachments: [] },
          },
        });
      }
      if (path.endsWith('/commands')) return Response.json([]);
      if (path.endsWith('/room-connection')) return Response.json({ rooms: ['room'] });
      if (path.endsWith('/room-reservations')) return Response.json([]);
      return Response.json({ leaseSeconds: 30 });
    })
  );
  return { admitted };
}

function startWorker(
  root: string,
  adapter: ProviderAdapter,
  signal: AbortSignal,
  restoreRoomId?: string
) {
  return runSharedHost(
    {
      root,
      agentApiUrl: 'http://127.0.0.1/agent',
      token: randomUUID(),
      session: startingSession,
      input: {
        sessionId: 'session',
        cwd: root,
        runtimeMode: 'approval-required',
        env: {},
        mcpServers: {},
      },
      roomConnection: { connectionId: 'connection', restoreRoomId },
    },
    adapter,
    signal
  ).then(
    () => null,
    (error: unknown) => error
  );
}

it('runs what its controller routed to it, once however often it is handed over', async () => {
  // The controller appends before it starts or wakes the worker, so a controller
  // that dies in between hands the same event over again when it comes back.
  const root = await mkdtemp(join(tmpdir(), 'shared-host-handoff-'));
  roots.push(root);
  const stop = new AbortController();
  const { adapter, ran } = roomWorker();
  const { admitted } = admittingServer();
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    // Said before anything is routed here: a controller that finds no declaration
    // takes the legacy path and the session never hears about the message.
    await vi.waitFor(() => expect(readsHandoffs(root)).resolves.toBe(true), { timeout: 3000 });
    const routed = { sequence: 5, roomId: 'room', messageId: 'routed' };
    await handOff(root, routed);
    await vi.waitFor(() => expect(ran).toEqual(['routed']), { timeout: 3000 });
    await handOff(root, routed);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(ran).toEqual(['routed']);
    expect(admitted).toEqual(['routed']);
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
});

it('runs what was routed to it while it was down', async () => {
  // Where the controller survives and the worker does not, the event is already
  // on disk and nothing else will ever admit it: reading the journal on the way
  // up is the only thing standing between that message and silence.
  const root = await mkdtemp(join(tmpdir(), 'shared-host-handoff-down-'));
  roots.push(root);
  await declareHandoffCapability(root);
  await handOff(root, { sequence: 5, roomId: 'room', messageId: 'routed-while-down' });
  const stop = new AbortController();
  const { adapter, ran } = roomWorker();
  const { admitted } = admittingServer();
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(ran).toEqual(['routed-while-down']), { timeout: 3000 });
    expect(admitted).toEqual(['routed-while-down']);
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
});

it('gives back a delivery the room moved away from, and runs it when the room comes back', async () => {
  // The room can leave this session while an event is on its way here and be
  // back before the message is ever answered. A refusal is not the delivery
  // being finished, so the second routing of it has to run.
  const root = await mkdtemp(join(tmpdir(), 'shared-host-reassigned-'));
  roots.push(root);
  const stop = new AbortController();
  const { adapter, ran } = roomWorker();
  const notices: string[] = [];
  const admitted: string[] = [];
  let elsewhere = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/claim'))
        return Response.json({
          contractVersion: 1,
          throughSequence: 1,
          session: { ...startingSession, epoch: 'server-epoch' },
          turns: [],
          items: [],
          requests: [],
          commandStatuses: [],
          nextPageToken: null,
        });
      if (path.endsWith('/events')) {
        const event = JSON.parse(options.body as string) as HostEvent;
        if (event.body.type === 'notice') notices.push(event.body.message);
        return Response.json({ throughHostSequence: event.hostSequence });
      }
      if (path.endsWith('/room-message')) {
        const { message_id: messageId } = JSON.parse(options.body as string) as {
          message_id: string;
        };
        if (elsewhere)
          return Response.json(
            {
              code: 'ROOM_MESSAGE_REASSIGNED',
              detail: 'Another session of this agent holds the room.',
            },
            { status: 409 }
          );
        admitted.push(messageId);
        return Response.json({
          type: 'command.status',
          commandId: `command-${messageId}`,
          status: 'accepted',
          code: null,
          message: null,
          command: {
            contractVersion: 1,
            commandId: `command-${messageId}`,
            sessionId: 'session',
            epoch: 'server-epoch',
            origin: {
              actorId: '@owner:example.test',
              surface: 'slack',
              roomId: 'room',
              threadId: null,
              messageId,
            },
            body: { type: 'message.send', delivery: 'queue', text: messageId, attachments: [] },
          },
        });
      }
      if (path.endsWith('/commands')) return Response.json([]);
      if (path.endsWith('/room-connection')) return Response.json({ rooms: ['room'] });
      if (path.endsWith('/room-reservations')) return Response.json([]);
      return Response.json({ leaseSeconds: 30 });
    })
  );
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(readsHandoffs(root)).resolves.toBe(true), { timeout: 3000 });
    const routed = { sequence: 5, roomId: 'room', messageId: 'moved' };
    await handOff(root, routed);
    await vi.waitFor(() => expect(notices).toHaveLength(1), { timeout: 3000 });
    expect(notices[0]).toContain('moved');
    expect(ran).toEqual([]);
    elsewhere = false;
    await handOff(root, routed);
    await vi.waitFor(() => expect(ran).toEqual(['moved']), { timeout: 3000 });
    expect(admitted).toEqual(['moved']);
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
});

it('fetches a room command the admission handed nothing back for', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-host-room-'));
  roots.push(root);
  await writeFile(
    join(root, 'room-inbox.jsonl'),
    ['old-server', 'behind-other-work']
      .map((messageId, index) =>
        JSON.stringify({ type: 'received', sequence: index + 1, roomId: 'room', messageId })
      )
      .join('\n') + '\n'
  );
  const stop = new AbortController();
  let listener: (event: ProviderRuntimeEvent) => void = () => {};
  let live = false;
  const ran: string[] = [];
  const emit = (event: Record<string, unknown>) =>
    listener({
      ...event,
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
      return { provider: 'claude', sessionId: 'session', nativeSessionId: 'native' };
    }),
    sendTurn: vi.fn(async ({ turnId, text }) => {
      ran.push(text);
      emit({ type: 'turn.started', turnId });
      emit({ type: 'turn.completed', turnId, outcome: 'completed' });
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
      interrupt: false,
      reset: false,
      compact: false,
      modelChange: false,
      attachmentMimeTypes: [],
    },
  };
  const roomCommand = (messageId: string): Command => ({
    contractVersion: 1,
    commandId: `command-${messageId}`,
    sessionId: 'session',
    epoch: 'server-epoch',
    origin: {
      actorId: '@owner:example.test',
      surface: 'slack',
      roomId: 'room',
      threadId: null,
      messageId,
    },
    body: { type: 'message.send', delivery: 'queue', text: messageId, attachments: [] },
  });
  const admitted: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/claim'))
        return Response.json({
          contractVersion: 1,
          throughSequence: 1,
          session: { ...session, epoch: 'server-epoch' },
          turns: [],
          items: [],
          requests: [],
          commandStatuses: [],
          nextPageToken: null,
        });
      if (path.endsWith('/events')) {
        const event = JSON.parse(options.body as string) as HostEvent;
        return Response.json({ throughHostSequence: event.hostSequence });
      }
      if (path.endsWith('/room-message')) {
        const { message_id: messageId } = JSON.parse(options.body as string) as {
          message_id: string;
        };
        admitted.push(messageId);
        const receipt = {
          type: 'command.status',
          commandId: `command-${messageId}`,
          status: 'accepted',
          code: null,
          message: null,
        };
        // Two ways of being handed nothing that mean the same thing: a server
        // built before the field existed says nothing at all, and one holding
        // this message behind other work says null.
        return Response.json(messageId === 'old-server' ? receipt : { ...receipt, command: null });
      }
      if (path.endsWith('/commands'))
        return Response.json(admitted.length < 2 ? [] : admitted.map(roomCommand));
      if (path.endsWith('/room-connection')) return Response.json({ rooms: ['room'] });
      if (path.endsWith('/room-reservations')) return Response.json([]);
      return Response.json({ leaseSeconds: 30 });
    })
  );
  const running = runSharedHost(
    {
      root,
      agentApiUrl: 'http://127.0.0.1/agent',
      token: randomUUID(),
      session,
      input: {
        sessionId: 'session',
        cwd: root,
        runtimeMode: 'approval-required',
        env: {},
        mcpServers: {},
      },
      roomConnection: { connectionId: 'connection' },
    },
    adapter,
    stop.signal
  );
  const outcome = running.then(
    () => null,
    (error: unknown) => error
  );
  try {
    await vi.waitFor(() => expect(ran).toHaveLength(2), { timeout: 3000 });
    expect(ran).toEqual(['old-server', 'behind-other-work']);
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
});

it('records the rooms Switch answers its binding with', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-host-binding-'));
  roots.push(root);
  const stop = new AbortController();
  const { adapter } = roomWorker();
  admittingServer();
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(async () => expect(await boundRooms(root)).toEqual([['room']]), {
      timeout: 3000,
    });
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
});

it('starts, and says so, when its controller is not there yet to bind to', async () => {
  // Restoring Console brings workers up before the controller they bind to, so
  // the first binding of a perfectly healthy session is routinely refused.
  // Exiting there would leave the session quiesced with no transcript and
  // nothing to restart it; it runs, says it cannot be reached, and heals.
  const root = await mkdtemp(join(tmpdir(), 'shared-host-early-'));
  roots.push(root);
  const stop = new AbortController();
  const { adapter } = roomWorker();
  const notices: string[] = [];
  let refuse = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/claim'))
        return Response.json({
          contractVersion: 1,
          throughSequence: 1,
          session: { ...startingSession, epoch: 'server-epoch' },
          turns: [],
          items: [],
          requests: [],
          commandStatuses: [],
          nextPageToken: null,
        });
      if (path.endsWith('/room-connection'))
        return refuse
          ? Response.json(
              { code: 'NOT_AUTHORIZED', detail: 'The SDK room connection is not live.' },
              { status: 403 }
            )
          : Response.json({ rooms: ['room'] });
      if (path.endsWith('/events')) {
        const event = JSON.parse(options.body as string) as HostEvent;
        if (event.body.type === 'notice') notices.push(event.body.code);
        return Response.json({ throughHostSequence: event.hostSequence });
      }
      if (path.endsWith('/commands')) return Response.json([]);
      if (path.endsWith('/room-reservations')) return Response.json([]);
      return Response.json({ leaseSeconds: 30 });
    })
  );
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(notices).toEqual(['ROOM_DELIVERY_FAILED']), { timeout: 12000 });
    expect(adapter.startSession).toHaveBeenCalled();
    refuse = false;
    await vi.waitFor(
      async () => {
        expect(notices).toEqual(['ROOM_DELIVERY_FAILED', 'ROOM_DELIVERY_RESUMED']);
        expect(await boundRooms(root)).toEqual([['room']]);
      },
      { timeout: 12000 }
    );
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
}, 30000);

it('says in the transcript when its room connection is refused, and when it is back', async () => {
  // The connection belongs to the agent's controller, which can stop and be
  // started again under the same session. Nothing else would tell the agent
  // that the room it is waiting on has stopped reaching it.
  const root = await mkdtemp(join(tmpdir(), 'shared-host-unbound-'));
  roots.push(root);
  const stop = new AbortController();
  const { adapter } = roomWorker();
  const notices: string[] = [];
  let binds = 0;
  let refuse = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/claim'))
        return Response.json({
          contractVersion: 1,
          throughSequence: 1,
          session: { ...startingSession, epoch: 'server-epoch' },
          turns: [],
          items: [],
          requests: [],
          commandStatuses: [],
          nextPageToken: null,
        });
      if (path.endsWith('/room-connection')) {
        binds += 1;
        return refuse
          ? Response.json(
              { code: 'NOT_AUTHORIZED', detail: 'The SDK room connection is not live.' },
              { status: 403 }
            )
          : Response.json({ rooms: ['room'] });
      }
      if (path.endsWith('/events')) {
        const event = JSON.parse(options.body as string) as HostEvent;
        if (event.body.type === 'notice') notices.push(event.body.code);
        return Response.json({ throughHostSequence: event.hostSequence });
      }
      if (path.endsWith('/commands')) return Response.json([]);
      if (path.endsWith('/room-reservations')) return Response.json([]);
      return Response.json({ leaseSeconds: 30 });
    })
  );
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(binds).toBe(1), { timeout: 3000 });
    refuse = true;
    await vi.waitFor(() => expect(notices).toEqual(['ROOM_DELIVERY_FAILED']), { timeout: 12000 });
    refuse = false;
    await vi.waitFor(
      () => expect(notices).toEqual(['ROOM_DELIVERY_FAILED', 'ROOM_DELIVERY_RESUMED']),
      { timeout: 12000 }
    );
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
}, 30000);

type Owed = { room_id: string; message_id: string; sequence: number; expired: boolean };

/** Every record this session's room inbox has written, in order. */
async function inboxRecords(root: string): Promise<{ type: string; messageId?: string }[]> {
  const text = await readFile(join(root, 'room-inbox.jsonl'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .slice(0, -1)
    .map((line) => JSON.parse(line) as { type: string; messageId?: string });
}

/**
 * Admits what it is given, and answers a session asking what its own rooms owe
 * it with whatever the test is holding at the time.
 */
function owingServer(server: {
  owed: () => Owed[];
  /**
   * What the pull route answers with: 200 to say, anything else to refuse.
   *
   * Answering late is answering: a route that takes its time is what a session
   * with a healthy controller and an unhealthy fallback endpoint sees, and the
   * request's own signal is handed over so a test can hold one open for as
   * long as the host is willing to.
   */
  pullStatus: (signal: AbortSignal) => number | Promise<number>;
  blocked: (messageId: string) => boolean;
}) {
  const admitted: string[] = [];
  const notices: string[] = [];
  const pulled: unknown[] = [];
  const commandPolls: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/claim'))
        return Response.json({
          contractVersion: 1,
          throughSequence: 1,
          session: { ...startingSession, epoch: 'server-epoch' },
          turns: [],
          items: [],
          requests: [],
          commandStatuses: [],
          nextPageToken: null,
        });
      if (path.endsWith('/events')) {
        const event = JSON.parse(options.body as string) as HostEvent;
        if (event.body.type === 'notice') notices.push(event.body.message);
        return Response.json({ throughHostSequence: event.hostSequence });
      }
      if (path.endsWith('/room-reservations')) {
        pulled.push(JSON.parse(options.body as string));
        const status = await server.pullStatus(options.signal as AbortSignal);
        if (status === 200) return Response.json(server.owed());
        return Response.json({ detail: `the pull route answered ${status}` }, { status });
      }
      if (path.endsWith('/room-message')) {
        const { message_id: messageId, epoch } = JSON.parse(options.body as string) as {
          message_id: string;
          epoch: string;
        };
        if (server.blocked(messageId))
          return Response.json(
            {
              code: 'ROOM_MESSAGE_OUT_OF_ORDER',
              detail: 'An earlier delivery for this room has not been made.',
            },
            { status: 409 }
          );
        admitted.push(messageId);
        return Response.json({
          type: 'command.status',
          commandId: `command-${messageId}`,
          status: 'accepted',
          code: null,
          message: null,
          command: {
            contractVersion: 1,
            commandId: `command-${messageId}`,
            sessionId: 'session',
            epoch,
            origin: {
              actorId: '@owner:example.test',
              surface: 'slack',
              roomId: 'room',
              threadId: null,
              messageId,
            },
            body: { type: 'message.send', delivery: 'queue', text: messageId, attachments: [] },
          },
        });
      }
      if (path.endsWith('/commands')) {
        commandPolls.push(options.body);
        return Response.json([]);
      }
      if (path.endsWith('/room-connection')) return Response.json({ rooms: ['room'] });
      return Response.json({ leaseSeconds: 30 });
    })
  );
  return { admitted, notices, pulled, commandPolls };
}

it('asks Switch what its own rooms owe it, and runs what it is told', async () => {
  // The controller that would route to this session has gone and the server
  // still has this session serving the room, so nothing else will ever offer
  // it the message.
  const root = await mkdtemp(join(tmpdir(), 'shared-host-pull-'));
  roots.push(root);
  const stop = new AbortController();
  const { adapter, ran } = roomWorker();
  const server = owingServer({
    owed: () => [{ room_id: 'room', message_id: 'owed', sequence: 4, expired: false }],
    pullStatus: () => 200,
    blocked: () => false,
  });
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(ran).toEqual(['owed']), { timeout: 3000 });
    expect(server.admitted).toEqual(['owed']);
    // Asked for under the same lease everything else is: a session that cannot
    // prove it holds the room is told nothing about what the room owes.
    expect(server.pulled[0]).toEqual({ host_id: 'host', epoch: 'server-epoch' });
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
});

it('runs a delivery once, however often it is offered again', async () => {
  // The same delivery is owed until it is answered, so every poll offers it
  // again and a controller that comes back routes it as well. Running it twice
  // is the room hearing the same message twice.
  const root = await mkdtemp(join(tmpdir(), 'shared-host-pull-repeat-'));
  roots.push(root);
  const stop = new AbortController();
  const { adapter, ran } = roomWorker();
  const routed = { sequence: 4, roomId: 'room', messageId: 'owed' };
  const server = owingServer({
    owed: () => [{ room_id: 'room', message_id: 'owed', sequence: 4, expired: false }],
    pullStatus: () => 200,
    blocked: () => false,
  });
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(ran).toEqual(['owed']), { timeout: 3000 });
    await vi.waitFor(() => expect(readsHandoffs(root)).resolves.toBe(true), { timeout: 3000 });
    await handOff(root, routed);
    await vi.waitFor(() => expect(server.pulled.length).toBeGreaterThan(1), { timeout: 12000 });
    expect(ran).toEqual(['owed']);
    expect(server.admitted).toEqual(['owed']);
    expect(
      (await inboxRecords(root))
        .filter((record) => record.type === 'handoff')
        .map((r) => r.messageId)
    ).toEqual(['owed']);
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
}, 20000);

it('holds a delivery Switch will not take yet and makes it behind the one before it', async () => {
  // The delivery this session was routed and the delivery it found for itself
  // reach it in whatever order they reach it in, and the room's own order is
  // the server's to decide. Being told to wait is a wait, not a failure: the
  // delivery stays this session's, unacknowledged and not given back.
  const root = await mkdtemp(join(tmpdir(), 'shared-host-pull-order-'));
  roots.push(root);
  await writeFile(
    join(root, 'room-inbox.jsonl'),
    JSON.stringify({ type: 'received', sequence: 2, roomId: 'room', messageId: 'second' }) + '\n'
  );
  const stop = new AbortController();
  const { adapter, ran } = roomWorker();
  const server = owingServer({
    owed: () => [{ room_id: 'room', message_id: 'first', sequence: 1, expired: false }],
    pullStatus: () => 200,
    blocked: (messageId) => messageId === 'second' && !server.admitted.includes('first'),
  });
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(ran).toEqual(['first', 'second']), { timeout: 5000 });
    expect(server.admitted).toEqual(['first', 'second']);
    const records = await inboxRecords(root);
    expect(records.filter((record) => record.type === 'release')).toEqual([]);
    expect(records.filter((record) => record.type === 'ack')).toHaveLength(2);
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
}, 20000);

it('says once that a delivery Switch stopped promising was never made', async () => {
  // Switch holds a delivery for a session for a while and then stops. Nobody
  // else is left to notice: the room was told nothing, and the only party that
  // can say so is the session that was owed it.
  const root = await mkdtemp(join(tmpdir(), 'shared-host-pull-lapsed-'));
  roots.push(root);
  const stop = new AbortController();
  const { adapter, ran } = roomWorker();
  const server = owingServer({
    owed: () => [{ room_id: 'room', message_id: 'lapsed', sequence: 6, expired: true }],
    pullStatus: () => 200,
    blocked: () => false,
  });
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(server.notices).toHaveLength(1), { timeout: 3000 });
    expect(server.notices[0]).toContain('lapsed');
    await vi.waitFor(() => expect(server.pulled.length).toBeGreaterThan(1), { timeout: 12000 });
    expect(server.notices).toHaveLength(1);
    expect(ran).toEqual([]);
    expect(server.admitted).toEqual([]);
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
}, 20000);

it('stops asking a server that cannot say what a session is owed, and says so once', async () => {
  // A server built before the pull existed answers nothing here for ever, and
  // asking it every few seconds for the rest of the session would be noise.
  // What the loss costs is said plainly: this session hears about a room
  // message only while its controller is routing to it.
  const root = await mkdtemp(join(tmpdir(), 'shared-host-pull-unanswered-'));
  roots.push(root);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const stop = new AbortController();
  const { adapter, ran } = roomWorker();
  const server = owingServer({ owed: () => [], pullStatus: () => 404, blocked: () => false });
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(server.pulled).toHaveLength(1), { timeout: 3000 });
    await vi.waitFor(() => expect(readsHandoffs(root)).resolves.toBe(true), { timeout: 3000 });
    await handOff(root, { sequence: 3, roomId: 'room', messageId: 'routed' });
    await vi.waitFor(() => expect(ran).toEqual(['routed']), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 6000));
    expect(server.pulled).toHaveLength(1);
    expect(
      warn.mock.calls.filter(
        ([text]) => typeof text === 'string' && text.includes('does not answer')
      )
    ).toHaveLength(1);
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
}, 20000);

it('keeps serving what it is routed while Switch will not say what it is owed', async () => {
  // The pull is the second way to the same work, so a server unreachable on it
  // must cost nothing else. Waiting here until it answers would hold the loop
  // that drains the controller's handoffs, submits what this session has run
  // and collects its commands — every route that is still working.
  const root = await mkdtemp(join(tmpdir(), 'shared-host-pull-unavailable-'));
  roots.push(root);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const stop = new AbortController();
  const { adapter, ran } = roomWorker();
  let reachable = false;
  const server = owingServer({
    owed: () => [{ room_id: 'room', message_id: 'owed', sequence: 4, expired: false }],
    pullStatus: () => (reachable ? 200 : 503),
    blocked: () => false,
  });
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(server.pulled).toHaveLength(1), { timeout: 3000 });
    await vi.waitFor(() => expect(readsHandoffs(root)).resolves.toBe(true), { timeout: 3000 });
    await handOff(root, { sequence: 3, roomId: 'room', messageId: 'routed' });
    await vi.waitFor(() => expect(ran).toEqual(['routed']), { timeout: 5000 });
    expect(server.admitted).toEqual(['routed']);
    const polledWhileFailing = server.commandPolls.length;
    // Asked again on the poll's own cadence rather than in a tight loop, and
    // the work it was owed all along arrives once the route comes back.
    await vi.waitFor(() => expect(server.pulled.length).toBeGreaterThan(1), { timeout: 12000 });
    expect(server.commandPolls.length).toBeGreaterThan(polledWhileFailing);
    reachable = true;
    await vi.waitFor(() => expect(ran).toEqual(['routed', 'owed']), { timeout: 12000 });
    expect(server.admitted).toEqual(['routed', 'owed']);
    expect(
      warn.mock.calls.filter(
        ([text]) => typeof text === 'string' && text.includes('would not say what room work')
      )
    ).toHaveLength(1);
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
}, 30000);

/**
 * A pull route that answers only when the test lets it, or when the host
 * stops waiting — which is what a real one does when its request is aborted.
 */
function stalling(released: Promise<void>) {
  return (signal: AbortSignal) =>
    new Promise<number>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      void released.then(() => resolve(200));
    });
}

it('keeps running while the pull hangs, and takes up its answer when it lands', async () => {
  // The fallback route is the one thing here nothing waits for. A request to it
  // that never comes back must not stop the handoffs the controller writes, the
  // deliveries this session submits or the commands it collects — the controls
  // among them — and must not stack a second ask behind itself while it waits.
  const root = await mkdtemp(join(tmpdir(), 'shared-host-pull-slow-'));
  roots.push(root);
  const stop = new AbortController();
  const { adapter, ran } = roomWorker();
  let answer: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const server = owingServer({
    owed: () => [{ room_id: 'room', message_id: 'owed', sequence: 4, expired: false }],
    pullStatus: stalling(released),
    blocked: () => false,
  });
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(server.pulled).toHaveLength(1), { timeout: 3000 });
    await vi.waitFor(() => expect(readsHandoffs(root)).resolves.toBe(true), { timeout: 3000 });
    await handOff(root, { sequence: 3, roomId: 'room', messageId: 'routed' });
    // The pull is still outstanding, and the pushed message has been run and
    // submitted anyway.
    await vi.waitFor(() => expect(ran).toEqual(['routed']), { timeout: 3000 });
    expect(server.admitted).toEqual(['routed']);
    const polledWhileWaiting = server.commandPolls.length;
    await vi.waitFor(() => expect(server.commandPolls.length).toBeGreaterThan(polledWhileWaiting), {
      timeout: 3000,
    });
    expect(server.pulled).toHaveLength(1);

    answer();
    await vi.waitFor(() => expect(ran).toEqual(['routed', 'owed']), { timeout: 3000 });
    expect(server.admitted).toEqual(['routed', 'owed']);
    expect(server.commandPolls.length).toBeGreaterThan(polledWhileWaiting);
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
}, 20000);

it('settles its outstanding pull when the host stops, and acts on nothing after', async () => {
  // Stopping has to be the end of this route as much as of the others: a
  // request still in flight would answer into a session that has shut its
  // provider down and closed the files the answer would be written to.
  const root = await mkdtemp(join(tmpdir(), 'shared-host-pull-shutdown-'));
  roots.push(root);
  const stop = new AbortController();
  const { adapter, ran } = roomWorker();
  let answer: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const server = owingServer({
    owed: () => [{ room_id: 'room', message_id: 'owed', sequence: 4, expired: false }],
    pullStatus: stalling(released),
    blocked: () => false,
  });
  const outcome = startWorker(root, adapter, stop.signal);
  await vi.waitFor(() => expect(server.pulled).toHaveLength(1), { timeout: 3000 });

  stop.abort();
  expect(await outcome).toBeNull();

  // The answer this host never waited for, arriving after it has gone.
  answer();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(ran).toEqual([]);
  expect(server.admitted).toEqual([]);
  expect((await inboxRecords(root)).filter((record) => record.type === 'received')).toEqual([]);
}, 20000);

it('restores the saved room with the acquired lease before binding, without sending a turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-host-legacy-restore-'));
  roots.push(root);
  const stop = new AbortController();
  const { adapter, ran } = roomWorker();
  admittingServer();
  const server = globalThis.fetch;
  let restored = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/restore-legacy-room')) {
        expect(JSON.parse(options.body as string)).toEqual({
          host_id: 'host',
          epoch: 'server-epoch',
          room_id: 'room',
        });
        restored = true;
        return Response.json({ restored: true });
      }
      if (path.endsWith('/room-connection')) expect(restored).toBe(true);
      return server(url, options);
    })
  );
  const outcome = startWorker(root, adapter, stop.signal, 'room');
  try {
    await vi.waitFor(async () => expect(await boundRooms(root)).toEqual([['room']]));
    expect(ran).toEqual([]);
    expect(adapter.sendTurn).not.toHaveBeenCalled();
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
});

function restoreAnswering(response: () => Response, boundRoom: string) {
  const { admitted } = admittingServer();
  const server = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/restore-legacy-room')) return response();
      if (path.endsWith('/room-connection')) return Response.json({ rooms: [boundRoom] });
      return server(url, options);
    })
  );
  return { admitted };
}

const restoreRouteMissing = () => Response.json({ detail: 'Not Found' }, { status: 404 });

it('runs what is routed to it when the server cannot restore a saved room', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-host-legacy-restore-absent-'));
  roots.push(root);
  const stop = new AbortController();
  const { adapter, ran } = roomWorker();
  const { admitted } = restoreAnswering(restoreRouteMissing, 'room');
  const outcome = startWorker(root, adapter, stop.signal, 'room');
  try {
    await vi.waitFor(() => expect(readsHandoffs(root)).resolves.toBe(true), { timeout: 3000 });
    await handOff(root, { sequence: 5, roomId: 'room', messageId: 'routed' });
    await vi.waitFor(() => expect(ran).toEqual(['routed']), { timeout: 3000 });
    expect(adapter.startSession).toHaveBeenCalledOnce();
    expect(admitted).toEqual(['routed']);
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
});

it('keeps the room Switch has it bound to over a saved room the server cannot restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-host-legacy-restore-stale-'));
  roots.push(root);
  const stop = new AbortController();
  const { adapter } = roomWorker();
  restoreAnswering(restoreRouteMissing, 'other');
  const outcome = startWorker(root, adapter, stop.signal, 'room');
  try {
    await vi.waitFor(async () => expect(await boundRooms(root)).toEqual([['other']]));
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
});

it.each([
  ['a refusal from the restore route', 404, { code: 'NOT_FOUND', message: 'Session not found.' }],
  ['an authorization failure', 403, { code: 'NOT_AUTHORIZED', message: 'Not this host.' }],
  ['a lost lease', 409, { code: 'HOST_OFFLINE', message: 'Lease lapsed.' }],
])('stops on %s when restoring a saved room', async (_, status, body) => {
  const root = await mkdtemp(join(tmpdir(), 'shared-host-legacy-restore-refused-'));
  roots.push(root);
  const { adapter } = roomWorker();
  restoreAnswering(() => Response.json(body, { status }), 'room');
  expect(await startWorker(root, adapter, new AbortController().signal, 'room')).toBeInstanceOf(
    Error
  );
  expect(await boundRooms(root)).toEqual([]);
  expect(adapter.startSession).not.toHaveBeenCalled();
});

/**
 * Answers renewals with whatever the test says the server says about this
 * session's rooms, and keeps every renewal it was sent so a test can count
 * them against the asks for owed work they did or did not start.
 */
function renewing(answer: (epoch: string) => unknown) {
  const renewals: { query: string; epoch: string }[] = [];
  const server = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/renew')) {
        const { epoch } = JSON.parse(options.body as string) as { epoch: string };
        renewals.push({ query: parsed.search, epoch });
        return Response.json(answer(epoch));
      }
      return server(url, options);
    })
  );
  return renewals;
}

it('asks for its rooms’ work only while a renewal says some is owed', async () => {
  // With its controller healthy the answer is almost always nothing, and the
  // renewal it sends anyway has already said so: asking again would be a
  // request per session per interval that learns nothing.
  const root = await mkdtemp(join(tmpdir(), 'shared-host-hint-none-'));
  roots.push(root);
  const stop = new AbortController();
  const { adapter, ran } = roomWorker();
  let owed: Owed[] = [];
  const server = owingServer({ owed: () => owed, pullStatus: () => 200, blocked: () => false });
  const renewals = renewing(() => ({ leaseSeconds: 30, roomWork: owed.length > 0 }));
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(readsHandoffs(root)).resolves.toBe(true), { timeout: 3000 });
    await handOff(root, { sequence: 3, roomId: 'room', messageId: 'routed' });
    await vi.waitFor(() => expect(ran).toEqual(['routed']), { timeout: 3000 });
    await vi.waitFor(() => expect(renewals.length).toBeGreaterThanOrEqual(3), { timeout: 12000 });
    expect(server.pulled).toEqual([]);
    expect(renewals.every((renewal) => renewal.query === '?room_work=true')).toBe(true);

    // Reserved after the last renewal said nothing was: the next one says so,
    // and that is the ask that finds it.
    owed = [{ room_id: 'room', message_id: 'owed', sequence: 4, expired: false }];
    const saidNothing = renewals.length;
    await vi.waitFor(() => expect(ran).toEqual(['routed', 'owed']), { timeout: 8000 });
    expect(server.pulled.length).toBeGreaterThanOrEqual(1);
    expect(server.pulled.length).toBeLessThanOrEqual(renewals.length - saidNothing);
    expect(server.admitted).toEqual(['routed', 'owed']);
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
}, 30000);

it('asks once for each renewal that says work is owed, and no more', async () => {
  // A delivery Switch has stopped promising stays owed until the controller
  // clears it, so the server can go on saying yes to a session that already
  // knows. What that costs is bounded by the renewals, not by the loop.
  const root = await mkdtemp(join(tmpdir(), 'shared-host-hint-owed-'));
  roots.push(root);
  const stop = new AbortController();
  const { adapter } = roomWorker();
  const server = owingServer({
    owed: () => [{ room_id: 'room', message_id: 'lapsed', sequence: 6, expired: true }],
    pullStatus: () => 200,
    blocked: () => false,
  });
  const renewals = renewing(() => ({ leaseSeconds: 30, roomWork: true }));
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(renewals.length).toBeGreaterThanOrEqual(3), { timeout: 12000 });
    await vi.waitFor(() => expect(server.pulled.length).toBe(renewals.length), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(server.pulled.length).toBeLessThanOrEqual(renewals.length);
    expect(server.pulled.length).toBeGreaterThanOrEqual(renewals.length - 1);
    expect(server.notices).toHaveLength(1);
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
}, 20000);

it.each([
  ['says nothing about it', { leaseSeconds: 30 }],
  ['answers it with something other than yes or no', { leaseSeconds: 30, roomWork: 'yes' }],
])(
  'keeps asking on its interval when the server %s',
  async (_, answer) => {
    // A server that predates the question cannot say, and one whose answer is
    // not an answer has not said; either way only asking finds the work.
    const root = await mkdtemp(join(tmpdir(), 'shared-host-hint-unknown-'));
    roots.push(root);
    const stop = new AbortController();
    const { adapter, ran } = roomWorker();
    let owed: Owed[] = [];
    const server = owingServer({ owed: () => owed, pullStatus: () => 200, blocked: () => false });
    renewing(() => answer);
    const outcome = startWorker(root, adapter, stop.signal);
    try {
      await vi.waitFor(() => expect(server.pulled.length).toBeGreaterThanOrEqual(2), {
        timeout: 12000,
      });
      owed = [{ room_id: 'room', message_id: 'owed', sequence: 4, expired: false }];
      await vi.waitFor(() => expect(ran).toEqual(['owed']), { timeout: 8000 });
    } finally {
      stop.abort();
      expect(await outcome).toBeNull();
    }
  },
  30000
);

it('keeps renewing and serving handoffs while an ask the renewal started hangs', async () => {
  // A yes starts one ask. Later yeses while it is still out start nothing more,
  // and nothing else here waits for it: the ask gives up on its own deadline
  // and the next yes is what asks again.
  const root = await mkdtemp(join(tmpdir(), 'shared-host-hint-slow-'));
  roots.push(root);
  const stop = new AbortController();
  const { adapter, ran } = roomWorker();
  let answer: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const stall = stalling(released);
  let outstanding = 0;
  let mostOutstanding = 0;
  const server = owingServer({
    owed: () => [{ room_id: 'room', message_id: 'owed', sequence: 4, expired: false }],
    pullStatus: async (signal) => {
      outstanding += 1;
      mostOutstanding = Math.max(mostOutstanding, outstanding);
      try {
        return await stall(signal);
      } finally {
        outstanding -= 1;
      }
    },
    blocked: () => false,
  });
  const renewals = renewing(() => ({ leaseSeconds: 30, roomWork: true }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(server.pulled).toHaveLength(1), { timeout: 3000 });
    const renewedBefore = renewals.length;
    await vi.waitFor(() => expect(readsHandoffs(root)).resolves.toBe(true), { timeout: 3000 });
    await handOff(root, { sequence: 3, roomId: 'room', messageId: 'routed' });
    await vi.waitFor(() => expect(ran).toEqual(['routed']), { timeout: 3000 });
    await vi.waitFor(() => expect(renewals.length).toBeGreaterThanOrEqual(renewedBefore + 2), {
      timeout: 12000,
    });
    expect(mostOutstanding).toBe(1);
    expect(server.pulled.length).toBeLessThanOrEqual(renewals.length);

    answer();
    await vi.waitFor(() => expect(ran).toEqual(['routed', 'owed']), { timeout: 8000 });
    expect(server.admitted).toEqual(['routed', 'owed']);
    expect(mostOutstanding).toBe(1);
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
}, 30000);

const quiesced = () =>
  Response.json({ code: 'HOST_OFFLINE', message: 'Host execution is quiesced.' }, { status: 409 });

it.each([
  { said: 'an answer', late: null, when: 'after recovery' },
  { said: 'a lost lease', late: quiesced, when: 'after recovery' },
  { said: 'a lost lease', late: quiesced, when: 'during the reset' },
])(
  'acts on nothing a renewal or an ask said about the generation a reset replaced: $said $when',
  async ({ late, when }) => {
    // A reset gives the session a new generation. What the server said about its
    // rooms under the old one, and an answer to an ask made under it, belong to
    // a lease the session no longer holds — whether the ask succeeded or said
    // that old lease was gone.
    const root = await mkdtemp(join(tmpdir(), 'shared-host-hint-reset-'));
    roots.push(root);
    const stop = new AbortController();
    const { adapter, ran } = roomWorker();
    let answer: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let landed: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      landed = resolve;
    });
    const server = owingServer({
      owed: () => [{ room_id: 'room', message_id: 'stale', sequence: 4, expired: false }],
      pullStatus: stalling(released),
      blocked: () => false,
    });
    const renewals = renewing((epoch) => ({
      leaseSeconds: 30,
      roomWork: epoch === 'server-epoch',
    }));
    const snapshot = (epoch: string) =>
      Response.json({
        contractVersion: 1,
        throughSequence: 1,
        session: {
          ...startingSession,
          epoch,
          capabilities: { ...startingSession.capabilities, reset: true },
        },
        turns: [],
        items: [],
        requests: [],
        commandStatuses: [],
        nextPageToken: null,
      });
    let resetting = false;
    let reset = false;
    const owing = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: RequestInit) => {
        const path = new URL(url).pathname;
        if (path.endsWith('/room-reservations')) {
          const response = await owing(url, options);
          setTimeout(landed, 50);
          return late?.() ?? response;
        }
        if (path.endsWith('/claim')) return snapshot('server-epoch');
        if (path.endsWith('/recover')) {
          // Answered between standing the old generation down and granting
          // the new one, so what it said is kept before the generation moves.
          if (when === 'during the reset') {
            answer();
            await answered;
          }
          return snapshot('epoch-2');
        }
        if (path.endsWith('/commands') && resetting && !reset) {
          reset = true;
          return Response.json([
            {
              contractVersion: 1,
              commandId: 'reset',
              sessionId: 'session',
              epoch: 'server-epoch',
              origin: {
                actorId: '@owner:example.test',
                surface: 'slack',
                roomId: 'room',
                threadId: null,
                messageId: 'reset',
              },
              body: { type: 'session.reset' },
            },
          ]);
        }
        return owing(url, options);
      })
    );
    const outcome = startWorker(root, adapter, stop.signal);
    try {
      await vi.waitFor(() => expect(server.pulled).toHaveLength(1), { timeout: 3000 });
      await vi.waitFor(() => expect(readsHandoffs(root)).resolves.toBe(true), { timeout: 3000 });
      await handOff(root, { sequence: 3, roomId: 'room', messageId: 'routed' });
      await vi.waitFor(() => expect(ran).toEqual(['routed']), { timeout: 3000 });
      resetting = true;
      await vi.waitFor(
        () => expect(renewals.some((renewal) => renewal.epoch === 'epoch-2')).toBe(true),
        { timeout: 5000 }
      );

      // The old generation's ask answers now, and a renewal under the new one has
      // already said nothing is owed.
      answer();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(server.admitted).toEqual(['routed']);
      expect(ran).toEqual(['routed']);
      expect(
        (await inboxRecords(root)).filter(
          (record) => record.type === 'received' && record.messageId === 'stale'
        )
      ).toEqual([]);
      expect(server.pulled).toHaveLength(1);

      // And the recovered generation carries on: still renewing, still running.
      const renewed = renewals.length;
      await handOff(root, { sequence: 5, roomId: 'room', messageId: 'after' });
      await new Promise((r) => setTimeout(r, 3000));
      console.log(
        'DBG',
        server.admitted,
        ran,
        JSON.stringify((await inboxRecords(root)).slice(-4))
      );
      await vi.waitFor(() => expect(ran).toEqual(['routed', 'after']), { timeout: 3000 });
      await vi.waitFor(() => expect(renewals.length).toBeGreaterThan(renewed), { timeout: 7000 });
      expect(renewals.at(-1)?.epoch).toBe('epoch-2');
    } finally {
      stop.abort();
      expect(await outcome).toBeNull();
    }
  },
  30000
);

it('stops when an ask under the lease it holds says that lease is gone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-host-hint-offline-'));
  roots.push(root);
  const { adapter } = roomWorker();
  const server = owingServer({ owed: () => [], pullStatus: () => 200, blocked: () => false });
  renewing(() => ({ leaseSeconds: 30, roomWork: true }));
  const owing = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      if (new URL(url).pathname.endsWith('/room-reservations')) {
        await owing(url, options);
        return Response.json({ code: 'HOST_OFFLINE', message: 'Lease lapsed.' }, { status: 409 });
      }
      return owing(url, options);
    })
  );
  const error = await startWorker(root, adapter, new AbortController().signal);
  expect(error).toBeInstanceOf(SharedHostUnavailableError);
  expect(String(error)).toContain('Lease lapsed.');
  expect(String(error)).toContain('/room-reservations');
  const events = (await readFile(join(root, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(
    events.some(
      (event) => event.body.type === 'session.upsert' && event.body.session.status === 'stopped'
    )
  ).toBe(false);
  expect(server.pulled).toHaveLength(1);
}, 15000);

it('checks commands on wake instead of polling while idle and recovers a missed wake', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-host-command-wake-'));
  roots.push(root);
  admittingServer();
  const originalFetch = globalThis.fetch;
  let polls = 0;
  let queued: Command[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      if (new URL(url).pathname.endsWith('/commands')) {
        polls += 1;
        const batch = queued;
        queued = [];
        return Response.json(batch);
      }
      return originalFetch(url, options);
    })
  );
  const { adapter, ran } = roomWorker();
  const stop = new AbortController();
  const outcome = startWorker(root, adapter, stop.signal);
  const command = (id: string): Command => ({
    contractVersion: 1,
    commandId: id,
    sessionId: 'session',
    epoch: 'server-epoch',
    origin: { actorId: 'owner', surface: 'console', roomId: null, threadId: null, messageId: null },
    body: { type: 'message.send', delivery: 'queue', text: id, attachments: [] },
  });
  try {
    await vi.waitFor(() => expect(polls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(polls).toBe(1);
    queued.push(command('notified'));
    await wakeCommands(root);
    await vi.waitFor(() => expect(ran).toEqual(['notified']), { timeout: 1500 });
    // Let the successful batch drain to an empty response before losing a hint.
    await vi.waitFor(() => expect(polls).toBe(3));
    queued.push(command('missed-wakeup'));
    await vi.waitFor(() => expect(ran).toEqual(['notified', 'missed-wakeup']), { timeout: 6500 });
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
}, 12000);

it('waits for Core to acknowledge readiness before admitting room work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-host-ready-race-'));
  roots.push(root);
  await writeFile(
    join(root, 'room-inbox.jsonl'),
    JSON.stringify({ type: 'received', sequence: 1, roomId: 'room', messageId: 'raced' }) + '\n'
  );
  admittingServer();
  const originalFetch = globalThis.fetch;
  const { adapter, ran, emit } = roomWorker();
  const start = adapter.startSession;
  adapter.startSession = vi.fn(async (input) => {
    const result = await start(input);
    emit({ type: 'session.state.changed', status: 'starting' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    return result;
  });
  let injected = false;
  let ready = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/events')) {
        const event = JSON.parse(options.body as string);
        if (event.body.type === 'session.upsert') {
          ready = event.body.session.status === 'ready';
          if (!injected) {
            injected = true;
            emit({ type: 'session.state.changed', status: 'ready' });
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      }
      if (path.endsWith('/room-message') && !ready)
        return Response.json(
          { code: 'HOST_OFFLINE', message: 'The session is not ready.' },
          { status: 409 }
        );
      return originalFetch(url, options);
    })
  );
  const stop = new AbortController();
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(ran).toEqual(['raced']), { timeout: 3000 });
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
});
