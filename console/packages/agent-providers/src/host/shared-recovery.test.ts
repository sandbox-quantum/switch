import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command, HostEvent, Session, Snapshot } from '@switch-console/shared/session-v1';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderAdapter } from '../adapter';
import type { ProviderRuntimeEvent } from '../events';
import { runSharedHost } from './shared-host';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
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
  let stop = new AbortController();
  let running = runSharedHost(f.options, f.adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(f.adapter.sendTurn).toHaveBeenCalledTimes(1), { timeout: 3000 });
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
  running = runSharedHost(f.options, f.adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(f.adapter.startSession).toHaveBeenCalledTimes(2), {
      timeout: 3000,
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
  await vi.waitFor(() => expect(f.adapter.sendTurn).toHaveBeenCalledTimes(1), { timeout: 3000 });
  f.setExpired(true);
  expect(await outcome).toMatchObject({ name: 'SharedHostLeaseExpiredError' });
  expect(f.adapter.stopSession).toHaveBeenCalledTimes(1);
  f.setExpired(false);
  const resumed = runSharedHost(f.options, f.adapter, stop.signal);
  try {
    await vi.waitFor(() => expect(f.adapter.startSession).toHaveBeenCalledTimes(2));
    expect(f.adapter.sendTurn).toHaveBeenCalledTimes(1);
  } finally {
    stop.abort();
    await resumed;
  }
});
