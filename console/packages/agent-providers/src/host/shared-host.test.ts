import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command, HostEvent, Session } from '@switch-console/shared/session-v1';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderAdapter } from '../adapter';
import type { ProviderRuntimeEvent } from '../events';
import { declareHandoffCapability, handOff, readsHandoffs } from './handoff';
import { runSharedHost } from './shared-host';

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
  return { adapter, ran };
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
      return Response.json({ leaseSeconds: 30 });
    })
  );
  return { admitted };
}

function startWorker(root: string, adapter: ProviderAdapter, signal: AbortSignal) {
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
      roomConnection: { connectionId: 'connection' },
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

/** Writes the room set a session served over a connection of its own. */
async function servedLocally(root: string, rooms: string[]): Promise<void> {
  await writeFile(join(root, 'room-inbox.jsonl'), `${JSON.stringify({ type: 'rooms', rooms })}\n`, {
    mode: 0o600,
  });
}

const claimed = {
  contractVersion: 1,
  throughSequence: 1,
  session: { ...startingSession, epoch: 'server-epoch' },
  turns: [],
  items: [],
  requests: [],
  commandStatuses: [],
  nextPageToken: null,
};

it('offers Switch the room it was serving before anything else can answer for it', async () => {
  // A session of the build this one replaces kept its rooms on disk, so Switch
  // holds no claim for it and the binding would answer with none. The offer has
  // to come first, and after the inbox is listening: the moment Switch counts
  // this session the room's owner, an event for it can be routed here.
  const root = await mkdtemp(join(tmpdir(), 'shared-host-adopt-'));
  roots.push(root);
  await servedLocally(root, ['room']);
  const stop = new AbortController();
  const { adapter } = roomWorker();
  const order: string[] = [];
  let offered: unknown = null;
  let listening = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/claim')) return Response.json(claimed);
      if (path.endsWith('/adopt-rooms')) {
        order.push('adopt');
        offered = JSON.parse(options.body as string);
        listening = await readsHandoffs(root);
        return Response.json({ adopted: ['room'], refused: [] });
      }
      if (path.endsWith('/room-connection')) {
        order.push('bind');
        return Response.json({ rooms: ['room'] });
      }
      if (path.endsWith('/events')) {
        const event = JSON.parse(options.body as string) as HostEvent;
        return Response.json({ throughHostSequence: event.hostSequence });
      }
      if (path.endsWith('/commands')) return Response.json([]);
      return Response.json({ leaseSeconds: 30 });
    })
  );
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(order).toEqual(['adopt', 'bind']), { timeout: 3000 });
    expect(offered).toEqual({ host_id: 'host', epoch: 'server-epoch', room_ids: ['room'] });
    expect(listening).toBe(true);
    // The room came across, so the binding answers with it and the record of
    // what this session serves is the one it started from.
    expect(await boundRooms(root)).toEqual([['room']]);
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
});

it('offers nothing when it has no room of its own to carry across', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-host-adopt-none-'));
  roots.push(root);
  const stop = new AbortController();
  const { adapter } = roomWorker();
  const paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path.endsWith('/claim')) return Response.json(claimed);
      if (path.endsWith('/room-connection')) return Response.json({ rooms: ['room'] });
      if (path.endsWith('/events')) {
        const event = JSON.parse(options.body as string) as HostEvent;
        return Response.json({ throughHostSequence: event.hostSequence });
      }
      if (path.endsWith('/commands')) return Response.json([]);
      return Response.json({ leaseSeconds: 30 });
    })
  );
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(async () => expect(await boundRooms(root)).toEqual([['room']]), {
      timeout: 3000,
    });
    expect(paths.filter((path) => path.endsWith('/adopt-rooms'))).toEqual([]);
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
});

it('says which room Switch would not carry across, and runs on without it', async () => {
  // The room is somebody else's now, and the session comes up without it. What
  // it must not do is come up quietly without it: a conversation is about to be
  // answered by a session that knows nothing of the one before it.
  const root = await mkdtemp(join(tmpdir(), 'shared-host-adopt-refused-'));
  roots.push(root);
  await servedLocally(root, ['room']);
  const stop = new AbortController();
  const { adapter } = roomWorker();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/claim')) return Response.json(claimed);
      if (path.endsWith('/adopt-rooms'))
        return Response.json({ adopted: [], refused: [{ roomId: 'room', reason: 'ROOM_HELD' }] });
      if (path.endsWith('/room-connection')) return Response.json({ rooms: [] });
      if (path.endsWith('/events')) {
        const event = JSON.parse(options.body as string) as HostEvent;
        return Response.json({ throughHostSequence: event.hostSequence });
      }
      if (path.endsWith('/commands')) return Response.json([]);
      return Response.json({ leaseSeconds: 30 });
    })
  );
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(adapter.startSession).toHaveBeenCalled(), { timeout: 3000 });
    const said = warn.mock.calls.map(([message]) => String(message));
    expect(said.some((message) => message.includes('room') && message.includes('ROOM_HELD'))).toBe(
      true
    );
    await vi.waitFor(async () => expect(await boundRooms(root)).toEqual([['room'], []]), {
      timeout: 3000,
    });
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
});

it('starts, and says so, against a server that cannot carry rooms across at all', async () => {
  // A worker can reach a server older than itself. Losing the room there is the
  // behaviour it would have had anyway; refusing to start is not.
  const root = await mkdtemp(join(tmpdir(), 'shared-host-adopt-unsupported-'));
  roots.push(root);
  await servedLocally(root, ['room']);
  const stop = new AbortController();
  const { adapter } = roomWorker();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/claim')) return Response.json(claimed);
      if (path.endsWith('/adopt-rooms'))
        return Response.json({ detail: 'Not Found' }, { status: 404 });
      if (path.endsWith('/room-connection')) return Response.json({ rooms: [] });
      if (path.endsWith('/events')) {
        const event = JSON.parse(options.body as string) as HostEvent;
        return Response.json({ throughHostSequence: event.hostSequence });
      }
      if (path.endsWith('/commands')) return Response.json([]);
      return Response.json({ leaseSeconds: 30 });
    })
  );
  const outcome = startWorker(root, adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(adapter.startSession).toHaveBeenCalled(), { timeout: 3000 });
    expect(warn.mock.calls.map(([message]) => String(message)).join('\n')).toContain('404');
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
});

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
