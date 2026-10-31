import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command, Session } from '@switch-console/shared/session-v1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter } from '../adapter';
import type { ProviderRuntimeEvent } from '../events';
import { HostedSession } from './session-host';

if (process.platform === 'win32') vi.setConfig({ testTimeout: 60_000 });

const roots: string[] = [];
const hosts: HostedSession[] = [];

afterEach(async () => {
  while (hosts.length) {
    const host = hosts.pop();
    await host?.shutdown().catch(() => {});
  }
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

function setup(steeringEnabled = true) {
  let live = true;
  let listener: (event: ProviderRuntimeEvent) => void = () => {};
  const emit = (event: Partial<ProviderRuntimeEvent>) =>
    listener({
      ...event,
      provider: 'claude',
      sessionId: 'session',
      eventId: randomUUID(),
      createdAt: new Date().toISOString(),
    } as ProviderRuntimeEvent);

  const adapter: ProviderAdapter = {
    provider: 'claude',
    capabilities: {
      resume: true,
      steering: steeringEnabled,
      approvals: true,
      userInput: true,
      modelSwitchInSession: false,
    },
    startSession: vi.fn(async () => {
      live = true;
      emit({ type: 'session.state.changed', status: 'ready' });
      return { provider: 'claude', sessionId: 'session', nativeSessionId: 'native' };
    }),
    sendTurn: vi.fn(async (input) => {
      emit({ type: 'turn.started', turnId: input.turnId });
      return { turnId: input.turnId };
    }),
    interruptTurn: vi.fn(async () => {}),
    respondToRequest: vi.fn(async () => {}),
    respondToUserInput: vi.fn(async () => {}),
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

  const config = {
    session: {
      sessionId: 'session',
      agentId: 'agent',
      hostId: 'host',
      epoch: 'epoch',
      provider: 'claude',
      status: 'starting',
      connectivity: 'online',
      pendingRequestIds: [],
      capabilities: {
        input: steeringEnabled ? 'steer' : 'queue',
        approvals: true,
        questions: true,
        interrupt: true,
        reset: true,
        compact: false,
        modelChange: false,
        attachmentMimeTypes: [],
      },
    } as Session,
    input: {
      sessionId: 'session',
      cwd: tmpdir(),
      runtimeMode: 'approval-required' as const,
      env: {},
      mcpServers: {},
      connectorMcpServers: [],
    },
  };

  return { adapter, config, emit };
}

function makeMessage(
  commandId: string,
  delivery: 'queue' | 'steer' = 'queue',
  text = 'Hello'
): Command {
  return {
    contractVersion: 1,
    commandId,
    sessionId: 'session',
    epoch: 'epoch',
    origin: { actorId: 'user', surface: 'console', roomId: 'room-1', threadId: 'thread-1', messageId: commandId },
    body: {
      type: 'message.send',
      delivery,
      text,
      attachments: [],
    },
  };
}

async function startSession(steeringEnabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'sdk-host-steering-test-'));
  roots.push(root);
  const fixture = setup(steeringEnabled);
  const host = await HostedSession.start(root, fixture.config, fixture.adapter);
  hosts.push(host);
  return { ...fixture, root, host };
}

describe('SessionHost Mid-Turn Steering', () => {
  it('steers mid-turn message into running turn when provider supports steering', async () => {
    const { host, adapter } = await startSession(true);

    // Start first turn
    const first = makeMessage('cmd-1', 'queue', 'First question');
    await host.command(first);
    await vi.waitFor(() => expect(adapter.sendTurn).toHaveBeenCalledTimes(1));

    // Mock sendTurn to steer second turn
    vi.mocked(adapter.sendTurn).mockImplementationOnce(async (input) => {
      return { turnId: input.turnId, steeredInto: 'cmd-1' };
    });

    // Send steer message mid-turn
    const steerMsg = makeMessage('cmd-2', 'steer', 'Correction: use the other file');
    const status = await host.command(steerMsg);

    expect(status.status).toBe('applied');
    expect(adapter.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session',
        turnId: 'cmd-2',
        text: 'Correction: use the other file',
      })
    );

    // The user message should be recorded under the running turn (cmd-1)
    const items = host.snapshot().items;
    const steeredItem = items.find((i) => i.itemId === 'user-cmd-2');
    expect(steeredItem).toBeDefined();
    expect(steeredItem?.turnId).toBe('cmd-1');
    expect(steeredItem?.title).toBe('Steered into running turn');
    expect(steeredItem?.text).toBe('Correction: use the other file');
  });

  it('rejects delivery: steer when provider does not support steering', async () => {
    const { host } = await startSession(false);

    const steerMsg = makeMessage('cmd-1', 'steer', 'Hello');
    await expect(host.command(steerMsg)).rejects.toThrow('UNSUPPORTED_CAPABILITY');
  });

  it('falls back to queueing if provider throws during steering', async () => {
    const { host, adapter } = await startSession(true);

    // Start first turn
    const first = makeMessage('cmd-1', 'queue', 'First question');
    await host.command(first);
    await vi.waitFor(() => expect(adapter.sendTurn).toHaveBeenCalledTimes(1));

    // Mock sendTurn to reject the steering call
    vi.mocked(adapter.sendTurn).mockRejectedValueOnce(new Error('Provider cannot steer right now'));

    // Send steer message
    const steerMsg = makeMessage('cmd-2', 'steer', 'Correction');
    const status = await host.command(steerMsg);

    expect(status.status).toBe('applied');

    // Item should be queued with title indicating steering fallback
    const items = host.snapshot().items;
    const queuedItem = items.find((i) => i.itemId === 'user-cmd-2');
    expect(queuedItem).toBeDefined();
    expect(queuedItem?.turnId).toBe('cmd-2');
    expect(queuedItem?.title).toBe('Queued (steering fallback)');

    const turns = host.snapshot().turns;
    const turn2 = turns.find((t) => t.turnId === 'cmd-2');
    expect(turn2?.status).toBe('queued');
  });

  it('starts a new turn when running turn finishes right before steering call (turn-ending race)', async () => {
    const { host, adapter } = await startSession(true);

    // Start first turn
    const first = makeMessage('cmd-1', 'queue', 'First question');
    await host.command(first);
    await vi.waitFor(() => expect(adapter.sendTurn).toHaveBeenCalledTimes(1));

    // Mock sendTurn to return without steeredInto (adapter started fresh turn)
    vi.mocked(adapter.sendTurn).mockImplementationOnce(async (input) => {
      return { turnId: input.turnId };
    });

    const steerMsg = makeMessage('cmd-2', 'steer', 'Follow-up');
    const status = await host.command(steerMsg);

    expect(status.status).toBe('applied');

    const turns = host.snapshot().turns;
    const turn2 = turns.find((t) => t.turnId === 'cmd-2');
    expect(turn2?.status).toBe('running');

    const items = host.snapshot().items;
    const item2 = items.find((i) => i.itemId === 'user-cmd-2');
    expect(item2?.turnId).toBe('cmd-2');
  });

  it('does not re-send steered messages after a host restart', async () => {
    const { host, root, adapter, emit } = await startSession(true);

    const first = makeMessage('cmd-1', 'queue', 'First question');
    await host.command(first);
    await vi.waitFor(() => expect(adapter.sendTurn).toHaveBeenCalledTimes(1));

    vi.mocked(adapter.sendTurn).mockImplementationOnce(async (input) => {
      return { turnId: input.turnId, steeredInto: 'cmd-1' };
    });

    const steerMsg = makeMessage('cmd-2', 'steer', 'Correction');
    await host.command(steerMsg);

    // Complete the turn
    emit({ type: 'turn.completed', turnId: 'cmd-1', outcome: 'completed', usage: [] });

    await host.shutdown();

    // Restart the host from the same root
    const recoveredFixture = setup(true);
    const recoveredHost = await HostedSession.start(root, recoveredFixture.config, recoveredFixture.adapter);
    hosts.push(recoveredHost);

    // Neither command should be re-sent on restart
    expect(recoveredFixture.adapter.sendTurn).not.toHaveBeenCalled();
  });
});
