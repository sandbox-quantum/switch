import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command, Session } from '@switch-console/shared/session-v1';
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderConversationUnavailableError, type ProviderAdapter } from '../adapter';
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
it.each(['claude', 'codex', 'opencode', 'antigravity', 'cursor'] as const)(
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
    emit({ type: 'turn.completed', turnId: 'active', outcome: 'interrupted', usage: [] });
    emit({ type: 'session.exited', reason: 'Stopped' });
  });
  expect((await host.command({ ...message('stop'), body: { type: 'session.stop' } })).status).toBe(
    'applied'
  );
  await vi.waitFor(() => expect(host.snapshot().session.status).toBe('stopped'));
  expect(host.snapshot().turns.map((turn) => turn.status)).toEqual(['interrupted', 'interrupted']);
  expect(adapter.sendTurn).toHaveBeenCalledOnce();
});

it('knows what a turn spent from the moment it reads as ended, and after a restart', async () => {
  const { host, emit, root } = await start('claude');
  const spent = [
    { model: 'big', inputTokens: 10, outputTokens: 2, cacheReadTokens: 300, cacheWriteTokens: 0 },
  ];
  await host.command(message('spender'));
  await vi.waitFor(() => expect(host.snapshot().turns[0]?.status).toBe('running'));
  const seenWhenEnded: unknown[] = [];
  host.onPublished((event) => {
    if (event.body.type === 'turn.upsert' && event.body.status === 'completed')
      seenWhenEnded.push(host.usageOf(event.body.turnId));
  });
  emit({ type: 'turn.completed', turnId: 'spender', outcome: 'completed', usage: spent });
  await vi.waitFor(() => expect(seenWhenEnded).toEqual([spent]));
  await host.shutdown();
  const next = setup('claude');
  const recovered = await HostedSession.start(root, next.config, next.adapter);
  hosts.push(recovered);
  expect(recovered.usageOf('spender')).toEqual(spent);
  expect(recovered.usageOf('never-ran')).toEqual([]);
});

it('resets into a new epoch and native conversation while retaining history', async () => {
  const { host, adapter, emit, root } = await start('claude');
  await host.command(message('old-turn'));
  await vi.waitFor(() => expect(host.snapshot().turns[0]?.status).toBe('running'));
  // Completed only after the provider reported the turn started, or its late
  // start would put the turn back to running.
  await vi.waitFor(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
  emit({ type: 'turn.completed', turnId: 'old-turn', outcome: 'completed', usage: [] });
  await vi.waitFor(() => expect(host.snapshot().turns[0]?.status).toBe('completed'));
  // The turn reads completed a moment before the session reads ready again,
  // and a reset is refused until it does.
  await vi.waitFor(() => expect(host.snapshot().session.status).toBe('ready'));
  vi.mocked(adapter.startSession).mockImplementationOnce(async () => {
    emit({ type: 'session.state.changed', status: 'ready' });
    return { provider: 'claude', sessionId: 'session', nativeSessionId: 'fresh-native' };
  });
  const command = { ...message('reset'), body: { type: 'session.reset' as const } };
  expect((await host.command(command)).status).toBe('applied');
  expect(host.snapshot().session.epoch).not.toBe('epoch');
  expect(host.snapshot().items[0].text).toBe('Hello');
  expect(vi.mocked(adapter.startSession).mock.calls[1][0].resume).toBeUndefined();
  expect((await host.command(command)).status).toBe('applied');
  expect(adapter.startSession).toHaveBeenCalledTimes(2);
  await expect(host.command(message('stale'))).rejects.toThrow('STALE_EPOCH');
  await host.shutdown();
  const next = setup('claude');
  hosts.push(await HostedSession.start(root, next.config, next.adapter));
  expect(next.adapter.startSession).toHaveBeenCalledWith(
    expect.objectContaining({
      resume: { nativeSessionId: 'fresh-native' },
    })
  );
});

it('rejects reset with queued work or a pending native request', async () => {
  const { host, adapter, emit } = await start('claude');
  await host.command(message('active'));
  await host.command(message('queued'));
  emit({
    type: 'request.opened',
    turnId: 'active',
    requestId: 'permission',
    requestType: 'tool_approval',
    title: 'Run command',
    options: [{ decision: 'accept', label: 'Allow' }],
  });
  await vi.waitFor(() => expect(host.snapshot().requests).toHaveLength(1));
  await expect(
    host.command({ ...message('reset'), body: { type: 'session.reset' } })
  ).rejects.toThrow('SESSION_BUSY');
  expect(adapter.stopSession).not.toHaveBeenCalled();
  expect(host.snapshot().session.epoch).toBe('epoch');
  expect(host.snapshot().requests[0].state).toBe('open');
});

const interrupted: Command = { ...message('interrupted-reset'), body: { type: 'session.reset' } };
async function undecided(nativeRecorded: boolean) {
  const { host, root } = await start('claude');
  await host.shutdown();
  const line = (value: unknown) => JSON.stringify(value) + '\n';
  await appendFile(
    join(root, 'inbox.jsonl'),
    line({ type: 'accepted', command: interrupted }) +
      line({ type: 'dispatched', commandId: 'interrupted-reset' }) +
      line({ type: 'reset-started' }) +
      (nativeRecorded ? line({ type: 'native', nativeSessionId: 'possibly-created' }) : '')
  );
  const next = setup('claude');
  const config = { ...next.config, stageAttachments: async () => [] };
  const resumed = await HostedSession.start(root, config, next.adapter);
  hosts.push(resumed);
  return { ...next, root, host: resumed };
}

it.each([false, true])(
  'opens an uncertain reset for an explicit decision (native ID recorded: %s)',
  async (nativeRecorded) => {
    const { host, adapter } = await undecided(nativeRecorded);
    expect(adapter.startSession).not.toHaveBeenCalled();
    expect(host.resetDecisionPending).toBe(true);
    expect(host.snapshot().session.status).toBe('error');
    expect(host.snapshot().session.capabilities).toMatchObject({
      reset: true,
      modelChange: false,
      compact: false,
      attachmentMimeTypes: [],
    });
    expect(
      host
        .replay(0)
        .events.filter(
          (event) => event.body.type === 'notice' && event.body.code === 'RESET_OUTCOME_UNKNOWN'
        )
    ).toHaveLength(1);
    expect(host.status('interrupted-reset')).toMatchObject({
      status: 'unknown',
      code: 'HOST_RESTARTED',
    });
  }
);

it('rejects other commands while the reset outcome is undecided', async () => {
  const { host, adapter } = await undecided(true);
  const blocked = message('blocked');
  const error = await host.command(blocked).catch((reason: unknown) => reason);
  expect(String(error)).toContain('UNSUPPORTED_CAPABILITY: RESET_OUTCOME_UNKNOWN');
  await host.reject(blocked, error);
  expect(host.status('blocked')).toMatchObject({ status: 'rejected', code: 'COMMAND_REJECTED' });
  await expect(
    host.command({ ...message('compact'), body: { type: 'session.compact' } })
  ).rejects.toThrow('UNSUPPORTED_CAPABILITY: RESET_OUTCOME_UNKNOWN');
  expect(adapter.sendTurn).not.toHaveBeenCalled();
  expect(host.snapshot().session.status).toBe('error');
  expect(
    host
      .replay(0)
      .events.some((event) => event.body.type === 'notice' && event.body.code === 'HOST_ERROR')
  ).toBe(false);
});

it('starts a fresh conversation when the user decides an uncertain reset', async () => {
  const { host, adapter } = await undecided(true);
  const reset: Command = { ...message('decided-reset'), body: { type: 'session.reset' } };
  expect((await host.command(reset)).status).toBe('applied');
  expect(adapter.stopSession).not.toHaveBeenCalled();
  expect(adapter.startSession).toHaveBeenCalledOnce();
  expect(vi.mocked(adapter.startSession).mock.calls[0][0].resume).toBeUndefined();
  await vi.waitFor(() => expect(host.snapshot().session.status).toBe('ready'));
  expect(host.resetDecisionPending).toBe(false);
  expect(host.snapshot().session.capabilities.attachmentMimeTypes.length).toBeGreaterThan(0);
  expect(host.status('interrupted-reset')).toMatchObject({
    status: 'unknown',
    code: 'HOST_RESTARTED',
  });
  expect(
    host
      .replay(0)
      .events.some((event) => event.body.type === 'notice' && event.body.code === 'CONTEXT_RESET')
  ).toBe(true);
  const fresh = { ...message('after-decision'), epoch: host.snapshot().session.epoch };
  expect((await host.command(fresh)).status).toBe('applied');
});

it('stops an undecided session without touching an unstarted provider', async () => {
  const { host, adapter, root } = await undecided(false);
  expect((await host.command({ ...message('stop'), body: { type: 'session.stop' } })).status).toBe(
    'applied'
  );
  expect(adapter.stopSession).not.toHaveBeenCalled();
  expect(host.snapshot().session.status).toBe('stopped');
  await host.shutdown();
  const next = setup('claude');
  const resumed = await HostedSession.start(root, next.config, next.adapter);
  hosts.push(resumed);
  expect(resumed.snapshot().session.status).toBe('stopped');
  expect(next.adapter.startSession).not.toHaveBeenCalled();
});

it('resumes an ordinary interrupted session without a reset decision', async () => {
  const { host, root } = await start('claude');
  await host.shutdown();
  const next = setup('claude');
  const resumed = await HostedSession.start(root, next.config, next.adapter);
  hosts.push(resumed);
  expect(next.adapter.startSession).toHaveBeenCalledWith(
    expect.objectContaining({ resume: { nativeSessionId: 'native' } })
  );
  expect(resumed.resetDecisionPending).toBe(false);
  await vi.waitFor(() => expect(resumed.snapshot().session.status).toBe('ready'));
});

it('starts a new conversation on its own when the saved one is gone and never answered', async () => {
  const { host, root } = await start('claude');
  await host.shutdown();
  const next = setup('claude');
  vi.mocked(next.adapter.startSession).mockRejectedValueOnce(
    new ProviderConversationUnavailableError('claude', 'session', 'No saved conversation')
  );
  const restarted = await HostedSession.start(root, next.config, next.adapter);
  hosts.push(restarted);
  expect(restarted.resetDecisionPending).toBe(false);
  expect(next.adapter.startSession).toHaveBeenCalledTimes(2);
  expect(vi.mocked(next.adapter.startSession).mock.calls[1][0].resume).toBeUndefined();
  await vi.waitFor(() =>
    expect(restarted.replay(0).events.map((e) => e.body)).toContainEqual(
      expect.objectContaining({ code: 'CONVERSATION_STARTED_FRESH' })
    )
  );
});

it('validates native model choices and persists a confirmed choice across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-model-test-'));
  roots.push(root);
  const fixture = setup('claude');
  fixture.adapter.listModels = vi.fn(async () => [
    { id: 'model-a', label: 'Model A', options: { effort: ['low', 'high'] } },
  ]);
  fixture.adapter.setModel = vi.fn(async () => {});
  const host = await HostedSession.start(root, fixture.config, fixture.adapter);
  hosts.push(host);
  await vi.waitFor(() => expect(host.snapshot().session.models?.length).toBeGreaterThan(0));
  expect(host.snapshot().session.capabilities.modelChange).toBe(true);
  const command: Command = {
    ...message('model'),
    body: {
      type: 'session.model.set',
      modelId: 'model-a',
      options: { effort: 'high' },
    },
  };
  await expect(
    host.command({ ...command, body: { ...command.body, modelId: 'invented' } } as Command)
  ).rejects.toThrow('UNSUPPORTED_MODEL');
  await expect(
    host.command({
      ...command,
      body: { ...command.body, options: { effort: 'invented' } },
    } as Command)
  ).rejects.toThrow('UNSUPPORTED_MODEL');
  expect(fixture.adapter.setModel).not.toHaveBeenCalled();
  expect((await host.command(command)).status).toBe('applied');
  expect((await host.command(command)).status).toBe('applied');
  expect(fixture.adapter.setModel).toHaveBeenCalledTimes(1);
  expect(host.snapshot().session.model).toEqual({ id: 'model-a', options: { effort: 'high' } });
  await host.shutdown();
  const recovered = setup('claude');
  hosts.push(await HostedSession.start(root, recovered.config, recovered.adapter));
  expect(recovered.adapter.startSession).toHaveBeenCalledWith(
    expect.objectContaining({
      model: { id: 'model-a', options: { effort: 'high' } },
      resume: { nativeSessionId: 'native' },
    })
  );
});

it('leaves a lost model acknowledgement unknown and does not retry it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-model-test-'));
  roots.push(root);
  const fixture = setup('claude');
  fixture.adapter.listModels = vi.fn(async () => [{ id: 'model-a', label: 'A', options: {} }]);
  fixture.adapter.setModel = vi.fn(async () => {
    throw new Error('Acknowledgement lost');
  });
  const host = await HostedSession.start(root, fixture.config, fixture.adapter);
  hosts.push(host);
  await vi.waitFor(() => expect(host.snapshot().session.models?.length).toBeGreaterThan(0));
  const command: Command = {
    ...message('model'),
    body: { type: 'session.model.set', modelId: 'model-a', options: {} },
  };
  expect((await host.command(command)).status).toBe('unknown');
  expect((await host.command(command)).status).toBe('unknown');
  expect(fixture.adapter.setModel).toHaveBeenCalledTimes(1);
  expect(host.snapshot().session.model).toBeNull();
});

it('waits for native compaction and keeps history without sending a summarization prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-compact-test-'));
  roots.push(root);
  const fixture = setup('claude');
  let finish!: () => void;
  fixture.adapter.compactSession = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  const host = await HostedSession.start(root, fixture.config, fixture.adapter);
  hosts.push(host);
  await vi.waitFor(() => expect(host.snapshot().session.capabilities.compact).toBe(true));
  const command: Command = { ...message('compact'), body: { type: 'session.compact' } };
  const applied = host.command(command);
  await vi.waitFor(() => expect(fixture.adapter.compactSession).toHaveBeenCalledTimes(1));
  expect(host.status('compact').status).toBe('accepted');
  expect(host.snapshot().session.status).toBe('running');
  expect(
    host
      .replay(0)
      .events.some(
        (event) => event.body.type === 'notice' && event.body.code === 'COMPACTION_STARTED'
      )
  ).toBe(true);
  finish();
  expect((await applied).status).toBe('applied');
  expect(host.snapshot().session.status).toBe('ready');
  expect(host.snapshot().session.epoch).toBe('epoch');
  await host.command(command);
  expect(fixture.adapter.compactSession).toHaveBeenCalledTimes(1);
  expect(fixture.adapter.sendTurn).not.toHaveBeenCalled();
  expect(fixture.adapter.interruptTurn).not.toHaveBeenCalled();
});

it('stages attachments before dispatch and never executes after shutdown during transfer', async () => {
  const { adapter, config } = setup('codex');
  let resolve!: (files: Array<{ path: string; mimeType: string }>) => void;
  const promise = new Promise<Array<{ path: string; mimeType: string }>>((done) => {
    resolve = done;
  });
  const transfer = { promise, resolve };
  const root = await mkdtemp(join(tmpdir(), 'sdk-stage-stop-'));
  roots.push(root);
  const stageAttachments = vi.fn(() => transfer.promise);
  const host = await HostedSession.start(root, { ...config, stageAttachments }, adapter);
  await vi.waitFor(() =>
    expect(host.snapshot().session.capabilities.attachmentMimeTypes).toContain('text/plain')
  );
  const command = message('with-file');
  if (command.body.type !== 'message.send') throw new Error('Expected message');
  command.body.attachments = [
    { attachmentId: randomUUID(), name: 'note.txt', mimeType: 'text/plain', bytes: 4 },
  ];
  await host.command(command);
  await expect.poll(() => stageAttachments.mock.calls.length).toBe(1);
  expect(adapter.sendTurn).not.toHaveBeenCalled();
  await host.shutdown();
  transfer.resolve([{ path: '/execution-host/note.txt', mimeType: 'text/plain' }]);
  await expect
    .poll(() => host.snapshot().turns.find((turn) => turn.turnId === command.commandId)?.status)
    .toBe('error');
  expect(adapter.sendTurn).not.toHaveBeenCalled();
});

it('delivers staged execution paths once and keeps durable attachment metadata', async () => {
  const { adapter, config } = setup('codex');
  const root = await mkdtemp(join(tmpdir(), 'sdk-stage-delivery-'));
  roots.push(root);
  const staged = [{ path: '/execution-host/note.txt', mimeType: 'text/plain' }];
  const stageAttachments = vi.fn(async () => staged);
  const host = await HostedSession.start(root, { ...config, stageAttachments }, adapter);
  await vi.waitFor(() =>
    expect(host.snapshot().session.capabilities.attachmentMimeTypes).toContain('text/plain')
  );
  hosts.push(host);
  const command = message('with-file');
  if (command.body.type !== 'message.send') throw new Error('Expected message');
  command.body.attachments = [
    { attachmentId: randomUUID(), name: 'note.txt', mimeType: 'text/plain', bytes: 4 },
  ];
  await host.command(command);
  await host.command(command);
  await expect.poll(() => vi.mocked(adapter.sendTurn).mock.calls.length).toBe(1);
  expect(vi.mocked(adapter.sendTurn).mock.calls[0]?.[0].attachments).toEqual(staged);
  expect(stageAttachments).toHaveBeenCalledOnce();
  expect(host.snapshot().items.find((item) => item.kind === 'user-message')?.attachments).toEqual(
    command.body.attachments
  );
});

it('updates attachment support after a confirmed native model change', async () => {
  const { adapter, config } = setup('opencode');
  adapter.listModels = vi.fn(async () => [
    { id: 'text', label: 'Text', options: {}, imageInput: false },
    { id: 'vision', label: 'Vision', options: {}, imageInput: true },
  ]);
  adapter.setModel = vi.fn(async () => {});
  const root = await mkdtemp(join(tmpdir(), 'sdk-model-images-'));
  roots.push(root);
  const host = await HostedSession.start(
    root,
    {
      ...config,
      input: { ...config.input, model: { id: 'text' } },
      stageAttachments: async () => [],
    },
    adapter
  );
  hosts.push(host);
  await vi.waitFor(() => expect(host.snapshot().session.capabilities.modelChange).toBe(true));
  expect(host.snapshot().session.capabilities.attachmentMimeTypes).not.toContain('image/png');
  const image = message('image');
  if (image.body.type !== 'message.send') throw new Error('Expected message');
  image.body.attachments = [
    { attachmentId: randomUUID(), name: 'image.png', mimeType: 'image/png', bytes: 10 },
  ];
  await expect(host.command(image)).rejects.toThrow('attachment type');
  expect(adapter.sendTurn).not.toHaveBeenCalled();
  await host.command({
    ...message('vision'),
    body: { type: 'session.model.set', modelId: 'vision', options: {} },
  });
  expect(host.snapshot().session.capabilities.attachmentMimeTypes).toContain('image/png');
});

it('rejects unsupported native compaction without faulting the session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unsupported-compact-'));
  const { adapter, config } = setup('claude');
  const host = await HostedSession.start(root, config, adapter);
  try {
    await expect(
      host.command({ ...message('unsupported-compact'), body: { type: 'session.compact' } })
    ).rejects.toThrow('UNSUPPORTED_CAPABILITY');
    expect(host.snapshot().session.status).toBe('ready');
  } finally {
    await host.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

it('requires an explicit fresh reset when the provider cannot resume the saved conversation', async () => {
  const { host, adapter, emit, root } = await start('codex');
  // The provider has answered, so the lost conversation held something.
  await host.command(message('answered'));
  await vi.waitFor(() => expect(host.snapshot().turns[0]?.status).toBe('running'));
  // Completed only after the provider reported the turn started, or its late
  // start would put the turn back to running.
  await vi.waitFor(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
  emit({ type: 'turn.completed', turnId: 'answered', outcome: 'completed', usage: [] });
  await vi.waitFor(() => expect(host.snapshot().turns[0]?.status).toBe('completed'));
  await vi.waitFor(() => expect(host.snapshot().session.status).toBe('ready'));
  await host.shutdown();
  const next = setup('codex');
  vi.mocked(next.adapter.startSession).mockRejectedValueOnce(
    new ProviderConversationUnavailableError('codex', 'session', 'Saved conversation unavailable')
  );
  const recovered = await HostedSession.start(root, next.config, next.adapter);
  hosts.push(recovered);
  expect(recovered.resetDecisionPending).toBe(true);
  expect(recovered.snapshot().session.status).toBe('error');
  expect(next.adapter.startSession).toHaveBeenCalledTimes(1);
  expect(next.adapter.startSession).toHaveBeenCalledWith(
    expect.objectContaining({
      resume: { nativeSessionId: 'native' },
    })
  );
  await expect(
    recovered.command({ ...message('held'), epoch: recovered.snapshot().session.epoch })
  ).rejects.toThrow('NATIVE_CONVERSATION_UNAVAILABLE');
  expect(next.adapter.sendTurn).not.toHaveBeenCalled();
  const receipt = await recovered.command({
    ...message('fresh'),
    epoch: recovered.snapshot().session.epoch,
    body: { type: 'session.reset' },
  });
  expect(receipt.status).toBe('applied');
  expect(next.adapter.startSession).toHaveBeenCalledTimes(2);
  expect(vi.mocked(next.adapter.startSession).mock.calls[1][0].resume).toBeUndefined();
  expect(recovered.resetDecisionPending).toBe(false);
});

it('does not present authentication or transport failures as a missing conversation', async () => {
  const { host, root } = await start('codex');
  await host.shutdown();
  const next = setup('codex');
  vi.mocked(next.adapter.startSession).mockRejectedValueOnce(new Error('Authentication failed'));
  await expect(HostedSession.start(root, next.config, next.adapter)).rejects.toThrow(
    'Authentication failed'
  );
});

it('resumes a stopped native conversation only once per explicit operation without replaying work', async () => {
  const { root, host } = await start('claude');
  await host.command(message('before-stop'));
  await host.command({ ...message('stop'), body: { type: 'session.stop' } });
  await host.shutdown();
  const fixture = setup('claude');
  const resumeOperationId = randomUUID();
  const resumed = await HostedSession.start(
    root,
    { ...fixture.config, resumeOperationId },
    fixture.adapter
  );
  hosts.push(resumed);
  expect(fixture.adapter.startSession).toHaveBeenCalledWith(
    expect.objectContaining({ resume: { nativeSessionId: 'native' } })
  );
  expect(fixture.adapter.sendTurn).not.toHaveBeenCalled();
  expect(resumed.snapshot().turns.every((turn) => turn.status === 'interrupted')).toBe(true);
  expect(resumed.snapshot().session.status).toBe('ready');
  await resumed.command({
    ...message('stop-again'),
    epoch: resumed.snapshot().session.epoch,
    body: { type: 'session.stop' },
  });
  await resumed.shutdown();
  const again = setup('claude');
  const stopped = await HostedSession.start(
    root,
    { ...again.config, resumeOperationId },
    again.adapter
  );
  hosts.push(stopped);
  expect(stopped.snapshot().session.status).toBe('stopped');
  expect(again.adapter.startSession).not.toHaveBeenCalled();
});

it.each(['claude', 'codex', 'opencode', 'antigravity', 'cursor'] as const)(
  'starts %s without waiting for model discovery',
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), 'startup-models-'));
    roots.push(root);
    const fixture = setup(provider);
    let resolveModels!: (models: []) => void;
    fixture.adapter.listModels = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          resolveModels = resolve;
        })
    );
    const host = await HostedSession.start(root, fixture.config, fixture.adapter);
    hosts.push(host);
    expect(host.snapshot().session.status).toBe('ready');
    expect(fixture.adapter.listModels).toHaveBeenCalledOnce();
    expect((await host.command(message('before-models'))).status).toBe('applied');
    resolveModels([]);
  }
);

it('overlaps authentication with startup but waits for authentication before returning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'startup-auth-'));
  roots.push(root);
  const fixture = setup('claude');
  let authenticated!: () => void;
  const authenticate = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        authenticated = resolve;
      })
  );
  let returned = false;
  const starting = HostedSession.start(
    root,
    { ...fixture.config, authenticate },
    fixture.adapter
  ).then((host) => {
    returned = true;
    hosts.push(host);
    return host;
  });
  await vi.waitFor(() => expect(fixture.adapter.startSession).toHaveBeenCalledOnce());
  expect(authenticate).toHaveBeenCalledOnce();
  expect(returned).toBe(false);
  authenticated();
  expect((await starting).snapshot().session.status).toBe('ready');
});

it('cleans up the started provider when authentication fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'startup-auth-failed-'));
  roots.push(root);
  const fixture = setup('claude');
  await expect(
    HostedSession.start(
      root,
      {
        ...fixture.config,
        authenticate: async () => {
          throw new Error('Sign in required');
        },
      },
      fixture.adapter
    )
  ).rejects.toThrow('Sign in required');
  expect(fixture.adapter.stopSession).toHaveBeenCalledOnce();
  expect(fixture.adapter.sendTurn).not.toHaveBeenCalled();
});

it('reports model discovery failures without losing the usable session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'startup-models-failed-'));
  roots.push(root);
  const fixture = setup('claude');
  fixture.adapter.listModels = vi.fn(async () => {
    throw new Error('Model service unavailable');
  });
  const host = await HostedSession.start(root, fixture.config, fixture.adapter);
  hosts.push(host);
  await vi.waitFor(() =>
    expect(
      host
        .replay(0)
        .events.some(
          (event) => event.body.type === 'notice' && event.body.code === 'MODEL_CATALOG_UNAVAILABLE'
        )
    ).toBe(true)
  );
  expect(host.snapshot().session.status).toBe('ready');
});

it.each(['session.exited', 'session.state.changed'] as const)(
  'keeps the room claim recoverable when host cleanup emits %s',
  async (type) => {
    const { host, adapter, emit } = await start('claude');
    adapter.stopSession = vi.fn(async () => {
      if (type === 'session.exited') emit({ type, reason: 'Stopped' });
      else emit({ type, status: 'stopped' });
    });
    await host.command(message('working'));
    await host.shutdown();
    expect(adapter.stopSession).toHaveBeenCalled();
    expect(host.snapshot().session.status).not.toBe('stopped');
    expect(
      host
        .replay(0)
        .events.some(
          (event) => event.body.type === 'session.upsert' && event.body.session.status === 'stopped'
        )
    ).toBe(false);
  }
);

async function openApproval(
  emit: (event: Record<string, unknown>) => void,
  host: HostedSession
): Promise<void> {
  emit({
    type: 'request.opened',
    turnId: 'turn',
    requestId: 'permission',
    requestType: 'tool_approval',
    title: 'Write file',
    options: [
      { decision: 'accept', label: 'Allow' },
      { decision: 'decline', label: 'Deny' },
    ],
  });
  await vi.waitFor(() => expect(host.snapshot().requests[0]?.state).toBe('open'));
}

it('applies an answer Switch recorded for an approval, once', async () => {
  const { host, adapter, emit } = await start('claude');
  await host.command(message('turn'));
  await openApproval(emit, host);
  const outcome = {
    requestId: 'permission',
    kind: 'approval' as const,
    state: 'answered' as const,
    answer: '1',
    answers: null,
    answeredBy: '@person:test',
  };

  expect(await host.applyApprovalOutcome(outcome)).toBe(true);
  expect(await host.applyApprovalOutcome(outcome)).toBe(false);

  expect(adapter.respondToRequest).toHaveBeenCalledExactlyOnceWith(
    'session',
    'permission',
    'decline'
  );
  expect(host.snapshot().requests[0]).toMatchObject({
    state: 'resolved',
    result: { outcome: 'answered', result: { kind: 'approval', optionId: '1' } },
    decidedBy: { actorId: '@person:test', surface: 'switch-web' },
  });
});

it('declines an approval Switch says expired, without interrupting the turn', async () => {
  const { host, adapter, emit } = await start('claude');
  await host.command(message('turn'));
  await openApproval(emit, host);

  expect(
    await host.applyApprovalOutcome({
      requestId: 'permission',
      kind: 'approval',
      state: 'expired',
      answer: null,
      answers: null,
      answeredBy: null,
    })
  ).toBe(true);

  expect(adapter.respondToRequest).toHaveBeenCalledExactlyOnceWith(
    'session',
    'permission',
    'decline'
  );
  expect(adapter.interruptTurn).not.toHaveBeenCalled();
  expect(host.snapshot().requests[0]).toMatchObject({
    state: 'closed',
    result: { outcome: 'expired', result: null },
  });
});

it('leaves an approval already answered another way alone', async () => {
  const { host, adapter, emit } = await start('claude');
  await host.command(message('turn'));
  await openApproval(emit, host);
  await host.command({
    ...message('answer'),
    body: {
      type: 'request.answer',
      requestId: 'permission',
      expectedRevision: 1,
      answer: { kind: 'approval', optionId: '0' },
    },
  });

  expect(
    await host.applyApprovalOutcome({
      requestId: 'permission',
      kind: 'approval',
      state: 'answered',
      answer: '1',
      answers: null,
      answeredBy: '@person:test',
    })
  ).toBe(false);
  expect(adapter.respondToRequest).toHaveBeenCalledExactlyOnceWith(
    'session',
    'permission',
    'accept'
  );
});

async function openQuestions(
  emit: (event: Record<string, unknown>) => void,
  host: HostedSession
): Promise<void> {
  emit({
    type: 'user-input.requested',
    turnId: 'turn',
    requestId: 'question',
    questions: [
      {
        id: 'colour',
        header: 'Colour',
        question: 'Which colours?',
        options: [
          { label: 'Red', value: 'red' },
          { label: 'Blue', value: 'blue' },
        ],
        multiSelect: true,
        allowCustomAnswer: true,
      },
    ],
  });
  await vi.waitFor(() => expect(host.snapshot().requests[0]?.state).toBe('open'));
}

it('answers questions with what Switch recorded for them', async () => {
  const { host, adapter, emit } = await start('claude');
  await host.command(message('turn'));
  await openQuestions(emit, host);
  const answers = [
    { questionId: 'colour', selectedOptionIds: ['colour:0', 'colour:1'], customText: ' Teal ' },
  ];

  expect(
    await host.applyApprovalOutcome({
      requestId: 'question',
      kind: 'questions',
      state: 'answered',
      answer: null,
      answers,
      answeredBy: '@person:test',
    })
  ).toBe(true);

  expect(adapter.respondToUserInput).toHaveBeenCalledExactlyOnceWith('session', 'question', {
    colour: ['red', 'blue', 'Teal'],
  });
  expect(host.snapshot().requests[0]).toMatchObject({
    state: 'resolved',
    result: { outcome: 'answered', result: { kind: 'questions', answers } },
    decidedBy: { actorId: '@person:test', surface: 'switch-web' },
  });
});

it('refuses answers Switch recorded that the questions never offered', async () => {
  const { host, adapter, emit } = await start('claude');
  await host.command(message('turn'));
  await openQuestions(emit, host);

  await expect(
    host.applyApprovalOutcome({
      requestId: 'question',
      kind: 'questions',
      state: 'answered',
      answer: null,
      answers: [{ questionId: 'colour', selectedOptionIds: ['colour:9'], customText: null }],
      answeredBy: '@person:test',
    })
  ).rejects.toThrow('INVALID_ANSWER');
  await expect(
    host.applyApprovalOutcome({
      requestId: 'question',
      kind: 'approval',
      state: 'answered',
      answer: '0',
      answers: null,
      answeredBy: '@person:test',
    })
  ).rejects.toThrow('INVALID_ANSWER');
  expect(adapter.respondToUserInput).not.toHaveBeenCalled();
  expect(host.snapshot().requests[0]?.state).toBe('open');
});

it('closes questions Switch says expired without answering them or interrupting the turn', async () => {
  const { host, adapter, emit } = await start('claude');
  await host.command(message('turn'));
  await openQuestions(emit, host);

  expect(
    await host.applyApprovalOutcome({
      requestId: 'question',
      kind: 'questions',
      state: 'expired',
      answer: null,
      answers: null,
      answeredBy: null,
    })
  ).toBe(true);

  expect(adapter.respondToUserInput).toHaveBeenCalledExactlyOnceWith('session', 'question', {});
  expect(adapter.interruptTurn).not.toHaveBeenCalled();
  expect(host.snapshot().requests[0]).toMatchObject({
    state: 'closed',
    result: { outcome: 'expired', result: null },
  });
});

it('knows which command started a turn', async () => {
  const { host } = await start('claude');
  await host.command(message('turn'));
  expect(host.originOf('turn')).toEqual(message('turn').origin);
  expect(host.originOf('unknown')).toBeNull();
});
