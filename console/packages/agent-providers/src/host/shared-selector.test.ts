import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command, HostEvent, Session } from '@switch-console/shared/session-v1';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderAdapter } from '../adapter';
import type { ProviderRuntimeEvent } from '../events';
import { SharedRoomInbox } from './room-inbox';
import { sessionSelectorPath } from './shared-config';
import { runSharedHost } from './shared-host';

/**
 * What this host tells its runtime about which session is calling.
 *
 * The runtime cannot work it out: it is handed a connection id, and a
 * connection may carry several sessions. So the host publishes the session's
 * own selector to a file the runtime reads on every operations call, and the
 * two things that can go wrong are both about timing. Publish before the
 * session has bound a connection and the server refuses every call the runtime
 * makes; leave a superseded epoch in place after a reset and it refuses them as
 * stale. Both failures look like a session that is running perfectly and cannot
 * say anything.
 */

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const SESSION: Session = {
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
    reset: true,
    compact: false,
    modelChange: false,
    attachmentMimeTypes: [],
  },
};

function adapterFor(): ProviderAdapter {
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
  return {
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
      return { provider: 'claude', sessionId: 'session', nativeSessionId: randomUUID() };
    }),
    sendTurn: vi.fn(async ({ turnId }) => ({ turnId })),
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
}

async function publishedSelector(root: string): Promise<Record<string, string> | null> {
  try {
    return JSON.parse(await readFile(sessionSelectorPath(root), 'utf8')) as Record<string, string>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

it('publishes the epoch the server minted, not the one the host proposed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-selector-'));
  roots.push(root);
  // A selector left by a previous worker for this same session. Its epoch died
  // with that worker, so it must not survive into this one's startup window.
  await writeFile(
    sessionSelectorPath(root),
    JSON.stringify({ session_id: 'session', host_id: 'host', epoch: 'worker-that-died' })
  );
  vi.spyOn(SharedRoomInbox.prototype, 'connect').mockResolvedValue(undefined);
  const stop = new AbortController();
  const seen: string[] = [];
  let atBind: Record<string, string> | null | 'never-bound' = 'never-bound';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      seen.push(path);
      if (path.endsWith('/claim'))
        return Response.json({
          contractVersion: 1,
          throughSequence: 1,
          session: { ...SESSION, epoch: 'server-epoch' },
          turns: [],
          items: [],
          requests: [],
          commandStatuses: [],
          nextPageToken: null,
        });
      if (path.endsWith('/room-connection')) {
        atBind = await publishedSelector(root);
        return Response.json({ rooms: ['room'] });
      }
      if (path.endsWith('/events'))
        return Response.json({
          throughHostSequence: (JSON.parse(options.body as string) as HostEvent).hostSequence,
        });
      if (path.endsWith('/commands')) return Response.json([]);
      return Response.json({ leaseSeconds: 30 });
    })
  );
  const running = runSharedHost(
    {
      root,
      agentApiUrl: 'http://127.0.0.1/agent',
      token: randomUUID(),
      session: SESSION,
      input: {
        sessionId: 'session',
        cwd: root,
        runtimeMode: 'approval-required',
        env: {},
        mcpServers: {},
      },
      roomConnection: { connectionId: 'connection', rooms: ['room'] },
    },
    adapterFor(),
    stop.signal
  );
  const outcome = running.then(
    () => null,
    (error: unknown) => error
  );
  try {
    await vi.waitFor(
      async () =>
        expect(await publishedSelector(root)).toEqual({
          session_id: 'session',
          host_id: 'host',
          epoch: 'server-epoch',
        }),
      { timeout: 3000 }
    );
    expect(seen).toContain('/agent/sessions/session/room-connection');
    // The dead worker's epoch was gone before this one bound, and nothing was
    // readable in its place: the server refuses a selector naming a session
    // that has bound no connection, so publishing early is worse than late.
    expect(atBind).toBeNull();
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
});

it('republishes the epoch a reset rotated into', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-selector-reset-'));
  roots.push(root);
  vi.spyOn(SharedRoomInbox.prototype, 'connect').mockResolvedValue(undefined);
  const stop = new AbortController();
  const reset: Command = {
    contractVersion: 1,
    commandId: 'reset',
    sessionId: 'session',
    epoch: 'server-epoch',
    origin: {
      actorId: 'verified-owner',
      surface: 'slack',
      roomId: 'room',
      threadId: null,
      messageId: 'card',
    },
    body: { type: 'session.reset' },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/claim'))
        return Response.json({
          contractVersion: 1,
          throughSequence: 1,
          session: { ...SESSION, epoch: 'server-epoch' },
          turns: [],
          items: [],
          requests: [],
          commandStatuses: [],
          nextPageToken: null,
        });
      if (path.endsWith('/recover'))
        return Response.json({
          contractVersion: 1,
          throughSequence: 1,
          session: { ...SESSION, epoch: 'rotated-epoch' },
          turns: [],
          items: [],
          requests: [],
          commandStatuses: [],
          nextPageToken: null,
        });
      if (path.endsWith('/room-connection')) return Response.json({ rooms: ['room'] });
      if (path.endsWith('/events'))
        return Response.json({
          throughHostSequence: (JSON.parse(options.body as string) as HostEvent).hostSequence,
        });
      // Switch holds a command open until its result is reported, so it is
      // re-offered on every poll rather than handed over once.
      if (path.endsWith('/commands')) return Response.json([reset]);
      return Response.json({ leaseSeconds: 30 });
    })
  );
  const running = runSharedHost(
    {
      root,
      agentApiUrl: 'http://127.0.0.1/agent',
      token: randomUUID(),
      session: SESSION,
      input: {
        sessionId: 'session',
        cwd: root,
        runtimeMode: 'approval-required',
        env: {},
        mcpServers: {},
      },
      roomConnection: { connectionId: 'connection', rooms: ['room'] },
    },
    adapterFor(),
    stop.signal
  );
  const outcome = running.then(
    () => null,
    (error: unknown) => error
  );
  try {
    await vi.waitFor(
      async () => expect((await publishedSelector(root))?.epoch).toBe('rotated-epoch'),
      { timeout: 5000 }
    );
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
});
