import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command, HostEvent, Session } from '@switch-console/shared/session-v1';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderAdapter } from '../adapter';
import type { ProviderRuntimeEvent } from '../events';
import { SharedRoomInbox } from './room-inbox';
import { runSharedHost } from './shared-host';

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
  vi.spyOn(SharedRoomInbox.prototype, 'connect').mockResolvedValue(undefined);
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
        expect(JSON.parse(options.body as string)).toMatchObject({
          message_id: 'message',
          include_command: true,
        });
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
      roomConnection: { connectionId: 'connection', rooms: ['room'] },
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
