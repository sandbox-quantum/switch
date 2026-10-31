import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@switch-console/shared/session-v1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter } from '../adapter';
import type { ProviderRuntimeEvent } from '../events';
import { stubSwitchFetch } from '../testing/agent-sessions-server';
import { Redactions } from './redaction';
import { ServiceNotices } from './service-notices';
import { connectParent } from './session-channel';
import { runSharedHost } from './shared-host';

if (process.platform === 'win32') vi.setConfig({ testTimeout: 60_000 });

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
  epoch: 'initial',
  provider: 'claude',
  status: 'starting',
  connectivity: 'online',
  pendingRequestIds: [],
  capabilities: {
    input: 'steer',
    approvals: true,
    questions: true,
    interrupt: false,
    reset: false,
    compact: false,
    modelChange: false,
    attachmentMimeTypes: [],
  },
};

import { EventEmitter } from 'node:events';

function fakeParent() {
  type Sent = {
    kind: string;
    id?: number;
    ok?: boolean;
    value?: unknown;
    error?: string;
    event?: { sequence: number };
    identity?: Record<string, string>;
    ask?: { type: string; roomId?: string };
  };
  const sent: Sent[] = [];
  const roomInstructions: { value: string | Error } = { value: '' };
  const port = Object.assign(new EventEmitter(), {
    connected: true,
    send: (message: unknown) => {
      const sentMessage = message as Sent;
      if (sentMessage.kind === 'ask' && sentMessage.ask?.type === 'room-instructions') {
        const { value } = roomInstructions;
        queueMicrotask(() =>
          port.emit(
            'message',
            value instanceof Error
              ? { kind: 'answer', id: sentMessage.id, ok: false, error: value.message }
              : { kind: 'answer', id: sentMessage.id, ok: true, value: { instructions: value } }
          )
        );
      }
      sent.push(sentMessage);
      return true;
    },
  });
  let nextId = 0;
  const ask = async (request: unknown): Promise<Sent> => {
    const id = nextId++;
    port.emit('message', { kind: 'request', id, request });
    let reply: Sent | undefined;
    await vi.waitFor(
      () => {
        reply = sent.find((message) => message.kind === 'reply' && message.id === id);
        expect(reply).toBeDefined();
      },
      { timeout: 5000 }
    );
    return reply!;
  };
  return { port, sent, ask, roomInstructions };
}

const roomMessage = (input: {
  sequence: number;
  sender: string;
  body: string;
  roomId?: string;
  threadId?: string | null;
  sender_role?: 'owner' | 'admin' | 'member' | null;
  sender_owns_agent?: boolean;
}) => ({
  sequence: input.sequence,
  roomId: input.roomId ?? 'room',
  messageId: `message-${input.sequence}`,
  event: {
    type: 'message',
    payload: {
      addressed: true,
      sender: input.sender,
      sender_name: input.sender.replace('@', '').replace(':test', ''),
      message_id: `message-${input.sequence}`,
      body: input.body,
      timestamp: input.sequence,
      thread_id: input.threadId ?? null,
      attachments: [],
      sender_role: input.sender_role ?? null,
      sender_owns_agent: input.sender_owns_agent ?? false,
    },
    missed: { count: 0, reason: null },
  },
});

async function startHost(opts: {
  steeringSupported?: boolean;
  midTurnDelivery?: 'steer' | 'queue';
}) {
  const root = await mkdtemp(join(tmpdir(), 'shared-host-steering-test-'));
  roots.push(root);
  const base = await mkdtemp(join(tmpdir(), 'shared-host-steering-base-'));
  roots.push(base);

  const parent = fakeParent();
  const stop = new AbortController();
  const turns: { turnId: string; text: string }[] = [];
  let listener: (event: ProviderRuntimeEvent) => void = () => {};
  let live = false;
  let activeRunningTurn: string | null = null;

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
      steering: opts.steeringSupported ?? true,
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
      turns.push({ turnId, text });
      if (activeRunningTurn !== null && (opts.steeringSupported ?? true)) {
        // Steering into running turn!
        return { turnId, steeredInto: activeRunningTurn };
      }
      activeRunningTurn = turnId;
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

  stubSwitchFetch(vi.fn(async () => new Response('{}', { status: 200 })));

  const session = structuredClone(SESSION);
  session.capabilities.input = (opts.steeringSupported ?? true) ? 'steer' : 'queue';
  const channel = connectParent(parent.port);

  const running = runSharedHost(
    {
      root,
      redactions: new Redactions(),
      serviceNotices: new ServiceNotices(),
      agentApiUrl: 'http://127.0.0.1/agent',
      token: randomUUID(),
      session,
      input: {
        sessionId: 'session',
        cwd: base,
        runtimeMode: 'approval-required',
        env: {},
        mcpServers: {},
        connectorMcpServers: [],
      },
      roomConnection: { connectionId: 'controller' },
      parent: channel,
      parkAfterMs: null,
      instructions: null,
      midTurnDelivery: opts.midTurnDelivery,
    },
    adapter,
    stop.signal
  );

  await vi.waitFor(() => expect(parent.sent.some((m) => m.kind === 'ready')).toBe(true), {
    timeout: 5000,
  });

  return {
    adapter,
    parent,
    turns,
    emit,
    stop: async () => {
      stop.abort();
      return running;
    },
  };
}

describe('shared-host mid-turn room message steering', () => {
  it('steers when a follow-up message is from the turn starter in the same thread', async () => {
    const host = await startHost({ steeringSupported: true });
    try {
      // 1. Initial message starts the turn
      const first = roomMessage({ sequence: 1, sender: '@alice:test', body: 'Start task' });
      expect(await host.parent.ask({ type: 'room', handoff: first })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(host.turns).toHaveLength(1), { timeout: 3000 });
      expect(host.adapter.sendTurn).toHaveBeenCalledTimes(1);

      // 2. While turn 1 is running, alice sends a mid-turn steering message in same thread
      const second = roomMessage({ sequence: 2, sender: '@alice:test', body: 'Focus on tests first' });
      expect(await host.parent.ask({ type: 'room', handoff: second })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(host.turns).toHaveLength(2), { timeout: 3000 });
      expect(host.adapter.sendTurn).toHaveBeenCalledTimes(2);

      // Verify the second turn call received the steering message
      expect(host.turns[1]?.text).toContain('Focus on tests first');
    } finally {
      await host.stop();
    }
  });

  it('steers when a mid-turn message is from the agent owner (sender_owns_agent: true)', async () => {
    const host = await startHost({ steeringSupported: true });
    try {
      // 1. Alice starts turn
      const first = roomMessage({ sequence: 1, sender: '@alice:test', body: 'Start task' });
      expect(await host.parent.ask({ type: 'room', handoff: first })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(host.turns).toHaveLength(1), { timeout: 3000 });

      // 2. Bob (agent owner) steers
      const second = roomMessage({
        sequence: 2,
        sender: '@bob:test',
        body: 'Owner redirect',
        sender_owns_agent: true,
      });
      expect(await host.parent.ask({ type: 'room', handoff: second })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(host.turns).toHaveLength(2), { timeout: 3000 });
      expect(host.adapter.sendTurn).toHaveBeenCalledTimes(2);
      expect(host.turns[1]?.text).toContain('Owner redirect');
    } finally {
      await host.stop();
    }
  });

  it('steers when a mid-turn message is from workspace owner (sender_role: "owner")', async () => {
    const host = await startHost({ steeringSupported: true });
    try {
      // 1. Alice starts turn
      const first = roomMessage({ sequence: 1, sender: '@alice:test', body: 'Start task' });
      expect(await host.parent.ask({ type: 'room', handoff: first })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(host.turns).toHaveLength(1), { timeout: 3000 });

      // 2. Carol (workspace owner role) steers
      const second = roomMessage({
        sequence: 2,
        sender: '@carol:test',
        body: 'Workspace owner redirect',
        sender_role: 'owner',
      });
      expect(await host.parent.ask({ type: 'room', handoff: second })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(host.turns).toHaveLength(2), { timeout: 3000 });
      expect(host.adapter.sendTurn).toHaveBeenCalledTimes(2);
      expect(host.turns[1]?.text).toContain('Workspace owner redirect');
    } finally {
      await host.stop();
    }
  });

  it('queues when another participant in the same thread sends a mid-turn message', async () => {
    const host = await startHost({ steeringSupported: true });
    try {
      // 1. Alice starts turn
      const first = roomMessage({ sequence: 1, sender: '@alice:test', body: 'Start task' });
      expect(await host.parent.ask({ type: 'room', handoff: first })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(host.turns).toHaveLength(1), { timeout: 3000 });

      // 2. Dave (not starter, not owner) sends message
      const second = roomMessage({
        sequence: 2,
        sender: '@dave:test',
        body: 'Dave message',
        sender_role: 'member',
        sender_owns_agent: false,
      });
      expect(await host.parent.ask({ type: 'room', handoff: second })).toMatchObject({ ok: true });

      // Give it time to attempt processing
      await new Promise((resolve) => setTimeout(resolve, 500));
      // sendTurn should NOT have been called for Dave because turn 1 is still running and Dave was queued!
      expect(host.adapter.sendTurn).toHaveBeenCalledTimes(1);
    } finally {
      await host.stop();
    }
  });

  it('queues when a message is from a different thread', async () => {
    const host = await startHost({ steeringSupported: true });
    try {
      // 1. Alice starts turn in thread 'thread-1'
      const first = roomMessage({
        sequence: 1,
        sender: '@alice:test',
        body: 'Start task',
        threadId: 'thread-1',
      });
      expect(await host.parent.ask({ type: 'room', handoff: first })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(host.turns).toHaveLength(1), { timeout: 3000 });

      // 2. Alice sends message in 'thread-2'
      const second = roomMessage({
        sequence: 2,
        sender: '@alice:test',
        body: 'Different thread task',
        threadId: 'thread-2',
      });
      expect(await host.parent.ask({ type: 'room', handoff: second })).toMatchObject({ ok: true });

      await new Promise((resolve) => setTimeout(resolve, 500));
      // Message from different thread must queue, not steer
      expect(host.adapter.sendTurn).toHaveBeenCalledTimes(1);
    } finally {
      await host.stop();
    }
  });

  it('queues when midTurnDelivery setting is set to queue', async () => {
    const host = await startHost({ steeringSupported: true, midTurnDelivery: 'queue' });
    try {
      // 1. Alice starts turn
      const first = roomMessage({ sequence: 1, sender: '@alice:test', body: 'Start task' });
      expect(await host.parent.ask({ type: 'room', handoff: first })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(host.turns).toHaveLength(1), { timeout: 3000 });

      // 2. Alice sends follow-up, but agent is configured to always queue
      const second = roomMessage({ sequence: 2, sender: '@alice:test', body: 'Follow-up' });
      expect(await host.parent.ask({ type: 'room', handoff: second })).toMatchObject({ ok: true });

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(host.adapter.sendTurn).toHaveBeenCalledTimes(1);
    } finally {
      await host.stop();
    }
  });

  it('queues when adapter does not support steering', async () => {
    const host = await startHost({ steeringSupported: false });
    try {
      // 1. Alice starts turn
      const first = roomMessage({ sequence: 1, sender: '@alice:test', body: 'Start task' });
      expect(await host.parent.ask({ type: 'room', handoff: first })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(host.turns).toHaveLength(1), { timeout: 3000 });

      // 2. Alice sends follow-up
      const second = roomMessage({ sequence: 2, sender: '@alice:test', body: 'Follow-up' });
      expect(await host.parent.ask({ type: 'room', handoff: second })).toMatchObject({ ok: true });

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(host.adapter.sendTurn).toHaveBeenCalledTimes(1);
    } finally {
      await host.stop();
    }
  });
});
