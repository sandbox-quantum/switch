import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command, Session } from '@switch-console/shared/session-v1';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderAdapter } from '../adapter';
import type { ProviderRuntimeEvent } from '../events';
import { HostedSession } from './session-host';

const roots: string[] = [];
const hosts: HostedSession[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function setup(provider: Session['provider']) {
  let listener: (event: ProviderRuntimeEvent) => void = () => {};
  let live = false;
  const emit = (event: Record<string, unknown>) =>
    listener({
      ...event,
      provider,
      sessionId: 'session',
      eventId: randomUUID(),
      createdAt: new Date().toISOString(),
    } as ProviderRuntimeEvent);
  const adapter: ProviderAdapter = {
    provider,
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
      return { provider, sessionId: 'session', nativeSessionId: 'native' };
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
      provider,
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
    } as Session,
    input: {
      sessionId: 'session',
      cwd: tmpdir(),
      runtimeMode: 'approval-required' as const,
      env: {},
      mcpServers: {},
    },
  };
  return { adapter, config, emit };
}
function message(commandId: string): Command {
  return {
    contractVersion: 1,
    commandId,
    sessionId: 'session',
    epoch: 'epoch',
    origin: { actorId: 'user', surface: 'console', roomId: null, threadId: null, messageId: null },
    body: {
      type: 'message.send',
      delivery: 'queue',
      text: 'Hello',
      attachments: [],
    },
  };
}
async function start(provider: Session['provider']) {
  const root = await mkdtemp(join(tmpdir(), 'sdk-host-test-'));
  roots.push(root);
  const fixture = setup(provider);
  const host = await HostedSession.start(root, fixture.config, fixture.adapter);
  hosts.push(host);
  await vi.waitFor(() => expect(host.snapshot().session.status).toBe('ready'));
  return { ...fixture, root, host };
}
it.each(['claude', 'codex', 'opencode', 'gemini', 'cursor'] as const)(
  'serializes and deduplicates %s commands across recovery',
  async (provider) => {
    const { root, host, adapter } = await start(provider);
    const command = message('first');
    expect((await host.command(command)).status).toBe('applied');
    await host.command(structuredClone(command));
    await host.command(message('second'));
    await vi.waitFor(() => expect(adapter.sendTurn).toHaveBeenCalledTimes(1));
    await expect(
      host.command({ ...command, body: { ...command.body, text: 'Changed' } } as Command)
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await host.shutdown();
    const recovered = setup(provider);
    const next = await HostedSession.start(root, recovered.config, recovered.adapter);
    hosts.push(next);
    expect(recovered.adapter.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ resume: { nativeSessionId: 'native' } })
    );
    expect(next.snapshot().items.filter((item) => item.kind === 'user-message')).toHaveLength(2);
    expect(next.snapshot().turns.every((turn) => turn.status === 'interrupted')).toBe(true);
    expect(recovered.adapter.sendTurn).not.toHaveBeenCalled();
    expect((await next.command(command)).status).toBe('applied');
    await expect(next.command(message('third'))).rejects.toThrow('STALE_EPOCH');
  }
);
it('keeps an explicitly stopped session stopped across restart', async () => {
  const { root, host } = await start('claude');
  await host.command({ ...message('stop'), body: { type: 'session.stop' } });
  await vi.waitFor(() => expect(host.snapshot().session.status).toBe('stopped'));
  await host.shutdown();
  const fixture = setup('claude');
  const recovered = await HostedSession.start(root, fixture.config, fixture.adapter);
  hosts.push(recovered);
  expect(recovered.snapshot().session.status).toBe('stopped');
  expect(fixture.adapter.startSession).not.toHaveBeenCalled();
});
it('keeps a failed callback outcome unknown and never retries the answer', async () => {
  const { host, adapter, emit } = await start('claude');
  await host.command(message('turn'));
  emit({
    type: 'request.opened',
    turnId: 'turn',
    requestId: 'permission',
    requestType: 'tool_approval',
    title: 'Write file',
    options: [{ decision: 'accept', label: 'Allow once' }],
  });
  await vi.waitFor(() => expect(host.snapshot().requests[0]?.state).toBe('open'));
  vi.mocked(adapter.respondToRequest).mockRejectedValueOnce(new Error('Provider exited'));
  const answer: Command = {
    ...message('answer'),
    body: {
      type: 'request.answer',
      requestId: 'permission',
      expectedRevision: 1,
      answer: { kind: 'approval', optionId: '0' },
    },
  };
  expect((await host.command(answer)).status).toBe('unknown');
  expect(host.snapshot().requests[0]).toMatchObject({
    state: 'closed',
    result: { outcome: 'provider-error' },
  });
  expect((await host.command(answer)).status).toBe('unknown');
  expect(adapter.respondToRequest).toHaveBeenCalledTimes(1);
  await expect(host.command({ ...answer, commandId: 'another-answer' })).rejects.toThrow(
    'REQUEST_CLOSED'
  );
});
it('settles unanswered questions when the provider exits', async () => {
  const { host, emit } = await start('cursor');
  await host.command(message('turn'));
  emit({
    type: 'user-input.requested',
    turnId: 'turn',
    requestId: 'question',
    questions: [
      {
        id: 'color',
        question: 'Choose a color',
        options: [{ label: 'Blue', value: 'blue' }],
        multiSelect: false,
        allowCustomAnswer: false,
      },
    ],
  });
  await vi.waitFor(() => expect(host.snapshot().requests[0]?.state).toBe('open'));
  emit({ type: 'session.exited', reason: 'Disconnected' });
  await vi.waitFor(() => expect(host.snapshot().requests[0]?.state).toBe('closed'));
  expect(host.snapshot().session.pendingRequestIds).toEqual([]);
});
it('rejects oversized input before persisting or dispatching a turn', async () => {
  const { host, adapter } = await start('claude');
  const command = message('large');
  if (command.body.type !== 'message.send') throw new Error('Expected message');
  command.body.text = 'x'.repeat(64 * 1024);
  await expect(host.command(command)).rejects.toThrow('PAYLOAD_TOO_LARGE');
  expect(host.snapshot().turns).toEqual([]);
  expect(host.snapshot().commandStatuses).toEqual([]);
  expect(adapter.sendTurn).not.toHaveBeenCalled();
});

it.each(['accept', 'decline', 'cancel'] as const)(
  'settles %s once and retains the deciding actor',
  async (decision) => {
    const { host, adapter, emit } = await start('claude');
    await host.command(message('turn'));
    emit({
      type: 'request.opened',
      turnId: 'turn',
      requestId: 'permission',
      requestType: 'tool_approval',
      title: 'Write file',
      options: [{ decision, label: decision }],
    });
    await vi.waitFor(() => expect(host.snapshot().requests[0]?.state).toBe('open'));
    const answer: Command = {
      ...message('answer'),
      body: {
        type: 'request.answer',
        requestId: 'permission',
        expectedRevision: 1,
        answer: { kind: 'approval', optionId: '0' },
      },
    };
    const results = await Promise.allSettled([
      host.command(answer),
      host.command(structuredClone(answer)),
      host.command({ ...answer, commandId: 'competing-answer' }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    expect(adapter.respondToRequest).toHaveBeenCalledExactlyOnceWith(
      'session',
      'permission',
      decision
    );
    expect(host.snapshot().requests[0]).toMatchObject({
      state: decision === 'cancel' ? 'closed' : 'resolved',
      result: {
        outcome: decision === 'cancel' ? 'cancelled' : 'answered',
        result: decision === 'cancel' ? null : { kind: 'approval', optionId: '0' },
      },
      decidedBy: { actorId: 'user', surface: 'console', commandId: 'answer' },
    });
    expect(host.snapshot().requests[0]).not.toHaveProperty('audience');
    expect(host.snapshot().items[0]).not.toHaveProperty('audience');
  }
);

it('rejects host publication claims before dispatching a command', async () => {
  const { host, adapter } = await start('claude');
  const command = message('turn');
  expect(() =>
    host.command({
      ...command,
      body: { ...command.body, audience: { kind: 'room', roomId: 'room', threadId: null } },
    } as unknown as Command)
  ).toThrow();
  expect(adapter.sendTurn).not.toHaveBeenCalled();
  expect(host.snapshot().commandStatuses).toEqual([]);
});

it('records uncertain interrupt delivery and never sends it twice', async () => {
  const { host, adapter } = await start('codex');
  await host.command(message('turn'));
  await vi.waitFor(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
  vi.mocked(adapter.interruptTurn).mockRejectedValue(new Error('Connection lost after send'));
  const interrupt: Command = {
    ...message('interrupt'),
    body: { type: 'turn.interrupt', turnId: 'turn' },
  };
  expect((await host.command(interrupt)).status).toBe('unknown');
  expect((await host.command(interrupt)).status).toBe('unknown');
  expect(adapter.interruptTurn).toHaveBeenCalledOnce();
});

it('rejects a completed turn interrupt without ending the host', async () => {
  const { host, adapter } = await start('codex');
  expect(
    (
      await host.command({
        ...message('interrupt'),
        body: { type: 'turn.interrupt', turnId: 'finished' },
      })
    ).status
  ).toBe('rejected');
  expect(adapter.interruptTurn).not.toHaveBeenCalled();
  expect((await host.command(message('next'))).status).toBe('applied');
});

it('keeps a stop with uncertain cleanup stopped on recovery', async () => {
  const { host, root, adapter } = await start('codex');
  vi.mocked(adapter.stopSession).mockRejectedValueOnce(new Error('Cleanup acknowledgement lost'));
  const stop: Command = { ...message('stop'), body: { type: 'session.stop' } };
  expect((await host.command(stop)).status).toBe('unknown');
  expect((await host.command(stop)).status).toBe('unknown');
  expect(adapter.stopSession).toHaveBeenCalledOnce();
  await host.shutdown();
  const recovered = setup('codex');
  const resumed = await HostedSession.start(root, recovered.config, recovered.adapter);
  hosts.push(resumed);
  expect(resumed.snapshot().session.status).toBe('stopped');
  expect(recovered.adapter.startSession).not.toHaveBeenCalled();
});

it('stops active and queued turns without dispatching the queue during cleanup', async () => {
  const { host, adapter, emit } = await start('codex');
  await host.command(message('active'));
  await host.command(message('queued'));
  await vi.waitFor(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
  vi.mocked(adapter.stopSession).mockImplementationOnce(async () => {
    emit({ type: 'turn.completed', turnId: 'active', outcome: 'interrupted' });
    emit({ type: 'session.exited', reason: 'Stopped' });
  });
  expect((await host.command({ ...message('stop'), body: { type: 'session.stop' } })).status).toBe(
    'applied'
  );
  await vi.waitFor(() => expect(host.snapshot().session.status).toBe('stopped'));
  expect(host.snapshot().turns.map((turn) => turn.status)).toEqual(['interrupted', 'interrupted']);
  expect(adapter.sendTurn).toHaveBeenCalledOnce();
});
