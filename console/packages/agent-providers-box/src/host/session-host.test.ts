import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command, Session } from '@switch-console/shared/session-v1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConversationUnavailableError, type ProviderAdapter } from '../adapter';
import type { ProviderRuntimeEvent } from '../events';
import { abandonWaits, announcing, changed, until } from '../testing/until';
import { RESTART_REPLY_ROUNDS, restartReplyGivenUp, restartReplyRounds } from './restart-rounds';
import { CONNECTOR_APPROVAL_NOTICE, ServiceNotices } from './service-notices';
import {
  HostedSession,
  RESTART_REPLY_RETRY_MS,
  RESTARTED_REPLY,
  type RoomReply,
  type RoomReplyOutcome,
  unpostedReply,
} from './session-host';
import { markStopAsked, stopWasAsked } from './stop-asked';

// Every step here is a journal write flushed to disk, and Windows runners take
// many times longer over that. The waits have no deadline of their own (see
// `until`), so this is the one clock: long enough for a slow disk, short
// enough that a host that never gets there still fails.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Polls a check that reads state nothing announces to `until` (a file the
 * host writes, a reply recorded by a fake parent), with room for a slow disk.
 */
function waitFor<T>(check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(check, { timeout: 10_000 });
}

/** A host that tells `until` each time it calls its provider or publishes an event. */
async function startHost(
  ...[root, config, adapter]: Parameters<typeof HostedSession.start>
): Promise<HostedSession> {
  const host = await HostedSession.start(root, config, announcing(adapter));
  host.onPublished(changed);
  return host;
}

const roots: string[] = [];
const hosts: HostedSession[] = [];
afterEach(async () => {
  try {
    for (const host of hosts.splice(0)) await host.shutdown();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  } finally {
    abandonWaits();
  }
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
      connectorMcpServers: [],
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
  const host = await startHost(root, fixture.config, fixture.adapter);
  hosts.push(host);
  await until(() => expect(host.snapshot().session.status).toBe('ready'));
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
    await until(() => expect(adapter.sendTurn).toHaveBeenCalledTimes(1));
    await expect(
      host.command({ ...command, body: { ...command.body, text: 'Changed' } } as Command)
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await host.shutdown();
    const recovered = setup(provider);
    const next = await startHost(root, recovered.config, recovered.adapter);
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
  await until(() => expect(host.snapshot().session.status).toBe('stopped'));
  await host.shutdown();
  const fixture = setup('claude');
  const recovered = await startHost(root, fixture.config, fixture.adapter);
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
  await until(() => expect(host.snapshot().requests[0]?.state).toBe('open'));
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
  await until(() => expect(host.snapshot().requests[0]?.state).toBe('open'));
  emit({ type: 'session.exited', reason: 'Disconnected' });
  await until(() => expect(host.snapshot().requests[0]?.state).toBe('closed'));
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
    await until(() => expect(host.snapshot().requests[0]?.state).toBe('open'));
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
  await until(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
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
  const resumed = await startHost(root, recovered.config, recovered.adapter);
  hosts.push(resumed);
  expect(resumed.snapshot().session.status).toBe('stopped');
  expect(recovered.adapter.startSession).not.toHaveBeenCalled();
});

it('stops active and queued turns without dispatching the queue during cleanup', async () => {
  const { host, adapter, emit } = await start('codex');
  await host.command(message('active'));
  await host.command(message('queued'));
  await until(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
  vi.mocked(adapter.stopSession).mockImplementationOnce(async () => {
    emit({ type: 'turn.completed', turnId: 'active', outcome: 'interrupted', usage: [] });
    emit({ type: 'session.exited', reason: 'Stopped' });
  });
  expect((await host.command({ ...message('stop'), body: { type: 'session.stop' } })).status).toBe(
    'applied'
  );
  await until(() => expect(host.snapshot().session.status).toBe('stopped'));
  expect(host.snapshot().turns.map((turn) => turn.status)).toEqual(['interrupted', 'interrupted']);
  expect(adapter.sendTurn).toHaveBeenCalledOnce();
});

it('knows what a turn spent from the moment it reads as ended, and after a restart', async () => {
  const { host, emit, root } = await start('claude');
  const spent = [
    { model: 'big', inputTokens: 10, outputTokens: 2, cacheReadTokens: 300, cacheWriteTokens: 0 },
  ];
  await host.command(message('spender'));
  await until(() => expect(host.snapshot().turns[0]?.status).toBe('running'));
  const seenWhenEnded = new Promise((resolve) =>
    host.onPublished((event) => {
      if (event.body.type === 'turn.upsert' && event.body.status === 'completed')
        resolve(host.usageOf(event.body.turnId));
    })
  );
  emit({ type: 'turn.completed', turnId: 'spender', outcome: 'completed', usage: spent });
  expect(await seenWhenEnded).toEqual(spent);
  await host.shutdown();
  const next = setup('claude');
  const recovered = await startHost(root, next.config, next.adapter);
  hosts.push(recovered);
  expect(recovered.usageOf('spender')).toEqual(spent);
  expect(recovered.usageOf('never-ran')).toEqual([]);
});

it('resets into a new epoch and native conversation while retaining history', async () => {
  const { host, adapter, emit, root } = await start('claude');
  await host.command(message('old-turn'));
  await until(() => expect(host.snapshot().turns[0]?.status).toBe('running'));
  // Completed only after the provider reported the turn started, or its late
  // start would put the turn back to running.
  await until(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
  emit({ type: 'turn.completed', turnId: 'old-turn', outcome: 'completed', usage: [] });
  await until(() => expect(host.snapshot().turns[0]?.status).toBe('completed'));
  // The turn reads completed a moment before the session reads ready again,
  // and a reset is refused until it does.
  await until(() => expect(host.snapshot().session.status).toBe('ready'));
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
  hosts.push(await startHost(root, next.config, next.adapter));
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
  await until(() => expect(host.snapshot().requests).toHaveLength(1));
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
  const resumed = await startHost(root, config, next.adapter);
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
  await until(() => expect(host.snapshot().session.status).toBe('ready'));
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
  const resumed = await startHost(root, next.config, next.adapter);
  hosts.push(resumed);
  expect(resumed.snapshot().session.status).toBe('stopped');
  expect(next.adapter.startSession).not.toHaveBeenCalled();
});

it('resumes an ordinary interrupted session without a reset decision', async () => {
  const { host, root } = await start('claude');
  await host.shutdown();
  const next = setup('claude');
  const resumed = await startHost(root, next.config, next.adapter);
  hosts.push(resumed);
  expect(next.adapter.startSession).toHaveBeenCalledWith(
    expect.objectContaining({ resume: { nativeSessionId: 'native' } })
  );
  expect(resumed.resetDecisionPending).toBe(false);
  await until(() => expect(resumed.snapshot().session.status).toBe('ready'));
});

it('starts a new conversation on its own when the saved one is gone and never answered', async () => {
  const { host, root } = await start('claude');
  await host.shutdown();
  const next = setup('claude');
  vi.mocked(next.adapter.startSession).mockRejectedValueOnce(
    new ProviderConversationUnavailableError('claude', 'session', 'No saved conversation')
  );
  const restarted = await startHost(root, next.config, next.adapter);
  hosts.push(restarted);
  expect(restarted.resetDecisionPending).toBe(false);
  expect(next.adapter.startSession).toHaveBeenCalledTimes(2);
  expect(vi.mocked(next.adapter.startSession).mock.calls[1][0].resume).toBeUndefined();
  await until(() =>
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
  const host = await startHost(root, fixture.config, fixture.adapter);
  hosts.push(host);
  await until(() => expect(host.snapshot().session.models?.length).toBeGreaterThan(0));
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
  hosts.push(await startHost(root, recovered.config, recovered.adapter));
  expect(recovered.adapter.startSession).toHaveBeenCalledWith(
    expect.objectContaining({
      model: { id: 'model-a', options: { effort: 'high' } },
      resume: { nativeSessionId: 'native' },
    })
  );
});

it('replays nothing to a caller already up to date, and the rest to one behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'replay-test-'));
  roots.push(root);
  const fixture = setup('opencode');
  const host = await HostedSession.start(root, fixture.config, fixture.adapter);
  hosts.push(host);
  await waitFor(() => expect(host.replay(0).events.length).toBeGreaterThan(0));
  const all = host.replay(0).events;
  const last = all.at(-1)!.sequence;
  expect(host.replay(last)).toEqual({ events: [], throughSequence: host.view().throughSequence });
  expect(host.replay(last + 5).events).toEqual([]);
  expect(host.replay(last - 1).events.map((e) => e.sequence)).toEqual([last]);
  expect(host.view()).toEqual(host.snapshot());
});

it('lists a catalog too large for a session event without its overflow, and keeps working', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-model-test-'));
  roots.push(root);
  const fixture = setup('opencode');
  const catalog = Array.from({ length: 600 }, (_, i) => ({
    id: `provider-${i}/model-with-a-long-identifier-${i}`,
    label: `Provider ${i} · A model with a long, descriptive label ${i}`,
    options: { variant: ['low', 'medium', 'high', 'max'] },
  }));
  fixture.adapter.listModels = vi.fn(async () => catalog);
  fixture.adapter.setModel = vi.fn(async () => {});
  const host = await startHost(root, fixture.config, fixture.adapter);
  hosts.push(host);
  await until(() => expect(host.snapshot().session.models?.length).toBeGreaterThan(0));
  const listed = host.snapshot().session.models!;
  expect(listed.length).toBeLessThan(catalog.length);
  expect(listed.every((model) => Object.keys(model.options).length === 0)).toBe(true);
  // The notice follows the session record it explains.
  await until(() =>
    expect(host.replay(0).events.map((e) => e.body)).toContainEqual(
      expect.objectContaining({ code: 'MODEL_CATALOG_TRUNCATED' })
    )
  );
  expect(host.replay(0).events.map((e) => e.body)).not.toContainEqual(
    expect.objectContaining({ code: 'MODEL_CATALOG_UNAVAILABLE' })
  );
  // The session record is published again on every turn; it still fits.
  expect((await host.command(message('after-catalog'))).status).not.toBe('rejected');
  expect(host.snapshot().session.status).not.toBe('error');
});

it('leaves a lost model acknowledgement unknown and does not retry it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-model-test-'));
  roots.push(root);
  const fixture = setup('claude');
  fixture.adapter.listModels = vi.fn(async () => [{ id: 'model-a', label: 'A', options: {} }]);
  fixture.adapter.setModel = vi.fn(async () => {
    throw new Error('Acknowledgement lost');
  });
  const host = await startHost(root, fixture.config, fixture.adapter);
  hosts.push(host);
  await until(() => expect(host.snapshot().session.models?.length).toBeGreaterThan(0));
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
  const host = await startHost(root, fixture.config, fixture.adapter);
  hosts.push(host);
  await until(() => expect(host.snapshot().session.capabilities.compact).toBe(true));
  const command: Command = { ...message('compact'), body: { type: 'session.compact' } };
  const applied = host.command(command);
  await until(() => expect(fixture.adapter.compactSession).toHaveBeenCalledTimes(1));
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

it('publishes context usage when a turn ends and clears it on reset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-context-test-'));
  roots.push(root);
  const fixture = setup('claude');
  fixture.adapter.contextUsage = vi.fn(async () => ({ usedTokens: 134000, windowTokens: 0 }));
  const host = await startHost(root, fixture.config, fixture.adapter);
  hosts.push(host);
  await until(() => expect(host.snapshot().session.status).toBe('ready'));
  expect(host.snapshot().session.context).toBeUndefined();
  await host.command(message('turn'));
  await until(() => expect(fixture.adapter.sendTurn).toHaveBeenCalledTimes(1));
  fixture.emit({ type: 'turn.completed', turnId: 'turn', outcome: 'completed', usage: [] });
  await until(() =>
    expect(host.snapshot().session.context).toMatchObject({
      usedTokens: 134000,
      windowTokens: null,
    })
  );
  await host.command({ ...message('reset'), body: { type: 'session.reset' } });
  await until(() => expect(host.snapshot().session.status).toBe('ready'));
  expect(host.snapshot().session.context).toBeNull();
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
  const host = await startHost(root, { ...config, stageAttachments }, adapter);
  await until(() =>
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
  const host = await startHost(root, { ...config, stageAttachments }, adapter);
  await until(() =>
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
  const host = await startHost(
    root,
    {
      ...config,
      input: { ...config.input, model: { id: 'text' } },
      stageAttachments: async () => [],
    },
    adapter
  );
  hosts.push(host);
  await until(() => expect(host.snapshot().session.capabilities.modelChange).toBe(true));
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
  const host = await startHost(root, config, adapter);
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
  await until(() => expect(host.snapshot().turns[0]?.status).toBe('running'));
  // Completed only after the provider reported the turn started, or its late
  // start would put the turn back to running.
  await until(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
  emit({ type: 'turn.completed', turnId: 'answered', outcome: 'completed', usage: [] });
  await until(() => expect(host.snapshot().turns[0]?.status).toBe('completed'));
  await until(() => expect(host.snapshot().session.status).toBe('ready'));
  await host.shutdown();
  const next = setup('codex');
  vi.mocked(next.adapter.startSession).mockRejectedValueOnce(
    new ProviderConversationUnavailableError('codex', 'session', 'Saved conversation unavailable')
  );
  const recovered = await startHost(root, next.config, next.adapter);
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
  await expect(startHost(root, next.config, next.adapter)).rejects.toThrow('Authentication failed');
});

it('resumes a stopped native conversation only once per explicit operation without replaying work', async () => {
  const { root, host } = await start('claude');
  await host.command(message('before-stop'));
  await host.command({ ...message('stop'), body: { type: 'session.stop' } });
  await host.shutdown();
  const fixture = setup('claude');
  const resumeOperationId = randomUUID();
  const resumed = await startHost(root, { ...fixture.config, resumeOperationId }, fixture.adapter);
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
  const stopped = await startHost(root, { ...again.config, resumeOperationId }, again.adapter);
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
    const host = await startHost(root, fixture.config, fixture.adapter);
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
  const starting = startHost(root, { ...fixture.config, authenticate }, fixture.adapter).then(
    (host) => {
      returned = true;
      hosts.push(host);
      return host;
    }
  );
  await until(() => expect(fixture.adapter.startSession).toHaveBeenCalledOnce());
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
    startHost(
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
  const host = await startHost(root, fixture.config, fixture.adapter);
  hosts.push(host);
  await until(() =>
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

it('never reads stopped while a reset replaces the conversation', async () => {
  const { host, adapter, emit } = await start('claude');
  adapter.stopSession = vi.fn(async () => {
    emit({ type: 'session.state.changed', status: 'stopped' });
    emit({ type: 'session.exited', reason: 'Stopped' });
  });
  const reset = { ...message('reset'), body: { type: 'session.reset' as const } };
  expect((await host.command(reset)).status).toBe('applied');
  expect(adapter.stopSession).toHaveBeenCalled();
  expect(
    host
      .replay(0)
      .events.some(
        (event) => event.body.type === 'session.upsert' && event.body.session.status === 'stopped'
      )
  ).toBe(false);
});

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
  await until(() => expect(host.snapshot().requests[0]?.state).toBe('open'));
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
  await until(() => expect(host.snapshot().requests[0]?.state).toBe('open'));
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

it('starts a conversation on recovery when the first start never opened one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-host-test-'));
  roots.push(root);
  const failing = setup('cursor');
  vi.mocked(failing.adapter.startSession).mockRejectedValueOnce(new Error('Invalid params'));
  await expect(startHost(root, failing.config, failing.adapter)).rejects.toThrow('Invalid params');
  const recovered = setup('cursor');
  const host = await startHost(root, recovered.config, recovered.adapter);
  hosts.push(host);
  expect(recovered.adapter.startSession).toHaveBeenCalledWith(
    expect.not.objectContaining({ resume: expect.anything() })
  );
  await until(() => expect(host.snapshot().session.status).toBe('ready'));
});

function roomMessage(commandId: string, threadId: string | null): Command {
  return {
    ...message(commandId),
    origin: {
      actorId: '@person:test',
      surface: 'switch-web',
      roomId: 'room',
      threadId,
      messageId: `message-${commandId}`,
    },
  };
}

/** A host that can post to its rooms, through `reply`. */
async function startReplying(
  reply: (reply: RoomReply) => Promise<RoomReplyOutcome | void>,
  root?: string,
  retryMs?: number[]
): Promise<Awaited<ReturnType<typeof start>>> {
  const dir = root ?? (await mkdtemp(join(tmpdir(), 'sdk-host-test-')));
  if (!root) roots.push(dir);
  const fixture = setup('cursor');
  const host = await startHost(
    dir,
    { ...fixture.config, replyToRoom: reply, ...(retryMs ? { restartReplyRetryMs: retryMs } : {}) },
    fixture.adapter
  );
  hosts.push(host);
  await until(() => expect(host.snapshot().session.status).toBe('ready'));
  return { ...fixture, root: dir, host };
}

function said(
  emit: (event: Record<string, unknown>) => void,
  turnId: string,
  id: string,
  text: string
) {
  emit({
    type: 'item.completed',
    turnId,
    item: { id, type: 'assistant_message', status: 'completed', title: '', text },
  });
}

async function roomReplyRecords(root: string): Promise<unknown[]> {
  return (await readFile(join(root, 'inbox.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => record.type === 'room-reply');
}

it('tells the room, and nothing of the final text, that a room turn finished without posting', async () => {
  const reply = vi.fn(async (_reply: RoomReply) => {});
  const { host, emit, root, adapter } = await startReplying(reply);
  await host.command(roomMessage('turn', 'thread'));
  await until(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
  said(emit, 'turn', 'first', 'Looking into it.');
  said(emit, 'turn', 'last', "You've hit your 5-hour limit, resets 8:40am");
  emit({ type: 'turn.completed', turnId: 'turn', outcome: 'completed', usage: [] });
  await until(() => expect(reply).toHaveBeenCalledOnce());
  expect(reply).toHaveBeenCalledWith({
    roomId: 'room',
    threadId: 'thread',
    body: 'I finished without replying.',
  });
  expect(await roomReplyRecords(root)).toEqual([{ type: 'room-reply', commandId: 'turn' }]);
});

it('posts nothing for a room turn in which the agent acted through a Switch tool', async () => {
  const reply = vi.fn(async (_reply: RoomReply) => {});
  const { host, emit, root, adapter } = await startReplying(reply);
  await host.command(roomMessage('acted', null));
  await until(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
  host.agentActedInSwitch();
  said(emit, 'acted', 'last', 'Done.');
  emit({ type: 'turn.completed', turnId: 'acted', outcome: 'completed', usage: [] });
  await until(() => expect(host.snapshot().turns[0]?.status).toBe('completed'));
  await host.barrier();
  expect(reply).not.toHaveBeenCalled();
  expect(await roomReplyRecords(root)).toEqual([]);
});

it('tells the room a turn failed after the agent acted, when no post landed', async () => {
  const reply = vi.fn(async (_reply: RoomReply) => {});
  const { host, emit, adapter } = await startReplying(reply);
  await host.command(roomMessage('acted', 'thread'));
  await until(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
  host.agentActedInSwitch();
  emit({
    type: 'turn.completed',
    turnId: 'acted',
    outcome: 'error',
    message: 'Upgrade your plan to continue',
    usage: [],
  });
  await until(() => expect(reply).toHaveBeenCalledOnce());
  expect(reply).toHaveBeenCalledWith({
    roomId: 'room',
    threadId: 'thread',
    body: 'I finished without replying. The turn failed: Upgrade your plan to continue',
  });
});

it('posts nothing when a message nobody tagged finished without a post', async () => {
  const reply = vi.fn(async (_reply: RoomReply) => {});
  const { host, emit, root, adapter } = await startReplying(reply);
  host.unaskedRoomTurn('routed');
  await host.command(roomMessage('routed', null));
  await until(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
  said(emit, 'routed', 'last', 'Not mine to answer.');
  emit({ type: 'turn.completed', turnId: 'routed', outcome: 'completed', usage: [] });
  await until(() => expect(host.snapshot().turns[0]?.status).toBe('completed'));
  await host.barrier();
  expect(reply).not.toHaveBeenCalled();
  expect(await roomReplyRecords(root)).toEqual([]);
});

it('posts nothing for a room turn someone interrupted', async () => {
  const reply = vi.fn(async (_reply: RoomReply) => {});
  const { host, emit, root, adapter } = await startReplying(reply);
  await host.command(roomMessage('stopped', null));
  await until(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
  said(emit, 'stopped', 'partial', 'Halfway through');
  emit({ type: 'turn.completed', turnId: 'stopped', outcome: 'interrupted', usage: [] });
  await until(() => expect(host.snapshot().turns[0]?.status).toBe('interrupted'));
  await host.barrier();
  expect(reply).not.toHaveBeenCalled();
  expect(await roomReplyRecords(root)).toEqual([]);
});

it('tells the room once, in its thread, that a turn failed without posting', async () => {
  const reply = vi.fn(async (_reply: RoomReply) => {});
  const { host, emit, root, adapter } = await startReplying(reply);
  await host.command(roomMessage('turn', 'thread'));
  await until(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
  emit({
    type: 'turn.completed',
    turnId: 'turn',
    outcome: 'error',
    message: 'Upgrade your plan to continue',
    usage: [],
  });
  await until(() =>
    expect(host.snapshot().notices.map((notice) => notice.code)).toContain('ROOM_REPLY_POSTED')
  );
  expect(reply).toHaveBeenCalledExactlyOnceWith({
    roomId: 'room',
    threadId: 'thread',
    body: 'I finished without replying. The turn failed: Upgrade your plan to continue',
  });
  expect(await roomReplyRecords(root)).toEqual([{ type: 'room-reply', commandId: 'turn' }]);

  await host.shutdown();
  const again = vi.fn(async (_reply: RoomReply) => {});
  const recovered = await startReplying(again, root);
  await recovered.host.barrier();
  expect(again).not.toHaveBeenCalled();
  expect(await roomReplyRecords(root)).toHaveLength(1);
});

it('leaves a room turn alone when the agent posted to the room during it', async () => {
  const reply = vi.fn(async (_reply: RoomReply) => {});
  const { host, emit, adapter } = await startReplying(reply);
  await host.command(roomMessage('posted', null));
  await until(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
  host.agentPostedToRoom();
  said(emit, 'posted', 'done', 'Posted the answer.');
  emit({ type: 'turn.completed', turnId: 'posted', outcome: 'completed', usage: [] });
  await until(() => expect(host.snapshot().turns[0]?.status).toBe('completed'));
  // A post counts for the turn it was made in, not the next one.
  await host.command(roomMessage('silent', null));
  await until(() => expect(adapter.sendTurn).toHaveBeenCalledTimes(2));
  emit({
    type: 'turn.completed',
    turnId: 'silent',
    outcome: 'error',
    message: 'boom',
    usage: [],
  });
  await until(() => expect(reply).toHaveBeenCalledOnce());
  expect(reply).toHaveBeenCalledWith({
    roomId: 'room',
    threadId: null,
    body: 'I finished without replying. The turn failed: boom',
  });
});

it('tells the room a failed turn with nothing to show failed, and why', async () => {
  const reply = vi.fn(async (_reply: RoomReply) => {});
  const { host, emit, adapter } = await startReplying(reply);
  await host.command(roomMessage('failed', 'thread'));
  await until(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
  emit({
    type: 'turn.completed',
    turnId: 'failed',
    outcome: 'error',
    message: 'Not signed in.',
    usage: [],
  });
  await until(() => expect(reply).toHaveBeenCalledOnce());
  expect(reply).toHaveBeenCalledWith({
    roomId: 'room',
    threadId: 'thread',
    body: 'I finished without replying. The turn failed: Not signed in.',
  });
});

it('tells the room a turn that never reached the provider failed', async () => {
  const reply = vi.fn(async (_reply: RoomReply) => {});
  const { host, adapter } = await startReplying(reply);
  vi.mocked(adapter.sendTurn).mockRejectedValueOnce(new Error('quota exhausted'));
  await host.command(roomMessage('unsent', null));
  await until(() => expect(reply).toHaveBeenCalledOnce());
  expect(reply.mock.calls[0]![0].body).toBe(
    'I finished without replying. The turn failed: Error: quota exhausted'
  );
});

it('posts nothing for a turn no room message started', async () => {
  const reply = vi.fn(async (_reply: RoomReply) => {});
  const { host, emit, adapter } = await startReplying(reply);
  await host.command(message('console'));
  await until(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
  said(emit, 'console', 'answer', 'Here you go.');
  emit({ type: 'turn.completed', turnId: 'console', outcome: 'completed', usage: [] });
  await until(() => expect(host.snapshot().turns[0]?.status).toBe('completed'));
  await host.barrier();
  expect(reply).not.toHaveBeenCalled();
});

it('posts nothing for a room turn the host stopped', async () => {
  const reply = vi.fn(async (_reply: RoomReply) => {});
  const { host, emit, adapter } = await startReplying(reply);
  await host.command(roomMessage('cut', null));
  await until(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
  vi.mocked(adapter.stopSession).mockImplementationOnce(async () => {
    emit({ type: 'turn.completed', turnId: 'cut', outcome: 'interrupted', usage: [] });
    emit({ type: 'session.exited', reason: 'Stopped' });
  });
  await host.command({ ...message('stop'), body: { type: 'session.stop' } });
  await until(() => expect(host.snapshot().session.status).toBe('stopped'));
  expect(reply).not.toHaveBeenCalled();
});

it('keeps the session working when the room reply cannot be posted', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const reply = vi.fn(async (_reply: RoomReply) => {
    throw new Error('Switch refused post_message');
  });
  const { host, emit, adapter } = await startReplying(reply);
  await host.command(roomMessage('first', null));
  await until(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
  emit({ type: 'turn.completed', turnId: 'first', outcome: 'error', message: 'boom', usage: [] });
  await until(() =>
    expect(host.snapshot().notices.map((notice) => notice.code)).toContain('ROOM_REPLY_FAILED')
  );
  expect(
    warn.mock.calls.some(([line]) => String(line).includes('Switch refused post_message'))
  ).toBe(true);
  expect((await host.command(message('second'))).status).toBe('applied');
  await until(() => expect(adapter.sendTurn).toHaveBeenCalledTimes(2));
  expect(host.snapshot().session.status).toBe('ready');
  warn.mockRestore();
});

it('says a turn failed, and why, or only that it finished; nothing for one stopped', () => {
  expect(unpostedReply('completed', null)).toBe('I finished without replying.');
  expect(unpostedReply('interrupted', 'Stopped by a person')).toBeNull();
  expect(unpostedReply('error', null)).toBe('I finished without replying. The turn failed.');
  expect(unpostedReply('error', 'Not signed in.')).toBe(
    'I finished without replying. The turn failed: Not signed in.'
  );
});

/**
 * One turn, as the provider reports it, with or without its reasoning; what
 * the host records and publishes for it, with the per-event noise removed.
 */
async function runTurn(provider: 'codex' | 'claude', withReasoning: boolean) {
  const { host, emit, root } = await start(provider);
  const published: unknown[] = [];
  host.onPublished((event) => published.push(event.body));
  await host.command(message('turn'));
  await until(() => expect(host.snapshot().turns[0]?.status).toBe('running'));
  const secret = 'PRIVATE REASONING TEXT';
  if (withReasoning) {
    if (provider === 'codex') {
      emit({
        type: 'item.started',
        turnId: 'turn',
        item: { id: 'r1', type: 'reasoning', status: 'in_progress', title: 'Reasoning' },
      });
      emit({ type: 'item.delta', turnId: 'turn', itemId: 'r1', delta: secret });
      emit({ type: 'content.delta', turnId: 'turn', itemId: 'r1', delta: ' more' });
    }
    emit({
      type: 'item.completed',
      turnId: 'turn',
      item: {
        id: 'r1',
        type: 'reasoning',
        status: 'completed',
        title: secret,
        text: `${secret} more`,
      },
    });
  }
  emit({
    type: 'item.completed',
    turnId: 'turn',
    item: { id: 'a1', type: 'assistant_message', status: 'completed', title: 'Done', text: 'Done' },
  });
  emit({ type: 'turn.completed', turnId: 'turn', outcome: 'completed', usage: [] });
  await until(() => expect(host.snapshot().turns[0]?.status).toBe('completed'));
  await host.barrier();
  const journal = await readFile(join(root, 'events.jsonl'), 'utf8');
  const snapshot = host.snapshot();
  const strip = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value, (key, field) =>
        ['eventId', 'occurredAt', 'revision', 'createdAt', 'updatedAt'].includes(key)
          ? undefined
          : field
      )
    );
  return {
    host,
    secret,
    journal,
    published: strip(published),
    snapshot: strip({ ...snapshot, session: { ...snapshot.session, epoch: null } }),
  };
}

it.each(['codex', 'claude'] as const)(
  'keeps %s reasoning off the event stream, the journal and the snapshot',
  async (provider) => {
    const withReasoning = await runTurn(provider, true);
    expect(withReasoning.journal).not.toContain(withReasoning.secret);
    expect(JSON.stringify(withReasoning.published)).not.toContain(withReasoning.secret);
    expect(JSON.stringify(withReasoning.snapshot)).not.toContain(withReasoning.secret);
    expect(withReasoning.host.reasoning(['turn']).turns[0]?.text).toBe(
      `${withReasoning.secret} more`
    );
    // What an older client or server sees is exactly what it saw before reasoning was kept.
    const without = await runTurn(provider, false);
    expect(withReasoning.published).toEqual(without.published);
    expect(withReasoning.snapshot).toEqual(without.snapshot);
    expect(without.host.reasoning(null).turns).toEqual([]);
  }
);

it('times reasoning only from a real start: Codex has one, Claude does not', async () => {
  const codex = await runTurn('codex', true);
  const [timed] = codex.host.reasoning(null).turns;
  expect(timed?.startedAt).toEqual(expect.any(String));
  expect(timed?.completedAt).toEqual(expect.any(String));
  expect(codex.host.reasoning(null).epoch).toBe(codex.host.snapshot().session.epoch);
  const claude = await runTurn('claude', true);
  const [untimed] = claude.host.reasoning(['turn', 'other']).turns;
  expect(untimed?.startedAt).toBeNull();
  expect(untimed?.completedAt).toEqual(expect.any(String));
});

it('keeps tool input and output off the event stream, the journal and the snapshot', async () => {
  const { host, emit, root } = await start('claude');
  const published: unknown[] = [];
  host.onPublished((event) => published.push(event.body));
  await host.command(message('turn'));
  await until(() => expect(host.snapshot().turns[0]?.status).toBe('running'));
  const input = { file_path: '/repo/PRIVATE-INPUT.ts' };
  const tool = { id: 't1', type: 'tool_call', title: 'Read', toolName: 'Read', payload: input };
  emit({ type: 'item.started', turnId: 'turn', item: { ...tool, status: 'in_progress' } });
  emit({
    type: 'item.completed',
    turnId: 'turn',
    item: { ...tool, status: 'completed', text: 'PRIVATE OUTPUT' },
  });
  emit({ type: 'turn.completed', turnId: 'turn', outcome: 'completed', usage: [] });
  await until(() => expect(host.snapshot().turns[0]?.status).toBe('completed'));
  await host.barrier();
  const journal = await readFile(join(root, 'events.jsonl'), 'utf8');
  for (const text of [journal, JSON.stringify(published), JSON.stringify(host.snapshot())]) {
    expect(text).not.toContain('PRIVATE-INPUT');
    expect(text).not.toContain('PRIVATE OUTPUT');
  }
  expect(host.reasoning(['turn']).tools).toEqual([
    {
      turnId: 'turn',
      tools: [expect.objectContaining({ input, output: 'PRIVATE OUTPUT', toolName: 'Read' })],
    },
  ]);
});

it("tells its owner when the provider asks to run a connector's tool, and only then", async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-host-test-'));
  roots.push(root);
  const fixture = setup('claude');
  const asked: string[] = [];
  const notices = new ServiceNotices();
  const host = await startHost(
    root,
    {
      ...fixture.config,
      connectorApproval: (connector) => {
        asked.push(connector);
        notices.raise(CONNECTOR_APPROVAL_NOTICE);
      },
    },
    fixture.adapter
  );
  hosts.push(host);
  notices.attach((message) => host.serviceFallback(message));
  const published: Array<{ type: string; message?: string; request?: { requestId: string } }> = [];
  host.onPublished((event) => published.push(event.body as (typeof published)[number]));
  await until(() => expect(host.snapshot().session.status).toBe('ready'));
  await host.command(message('turn'));
  const connectorRequest = (requestId: string) => ({
    type: 'request.opened' as const,
    turnId: 'turn',
    requestId,
    requestType: 'mcp_tool_approval' as const,
    title: `atlassian wants to run ${requestId}`,
    options: [{ decision: 'accept' as const, label: 'Allow once' }],
    connector: 'atlassian',
  });
  fixture.emit({
    type: 'request.opened',
    turnId: 'turn',
    requestId: 'bash',
    requestType: 'command_execution_approval',
    title: 'ls',
    options: [{ decision: 'accept', label: 'Allow once' }],
  });
  fixture.emit(connectorRequest('search'));
  fixture.emit(connectorRequest('add_comment'));
  await until(() => expect(host.snapshot().requests).toHaveLength(3));
  await host.barrier();
  expect(asked).toEqual(['atlassian', 'atlassian']);

  const order = published.flatMap((body) =>
    body.type === 'notice' && body.message === CONNECTOR_APPROVAL_NOTICE
      ? ['notice']
      : body.type === 'request.opened' && body.request
        ? [body.request.requestId]
        : []
  );
  expect(order).toEqual(['bash', 'notice', 'search', 'add_comment']);
});

describe('retrying a room message', () => {
  const roomMessage = (commandId: string): Command => ({
    ...message(commandId),
    origin: {
      actorId: 'user',
      surface: 'switch-web',
      roomId: 'room',
      threadId: null,
      messageId: 'm1',
    },
  });
  const retry = (commandId: string): Command => ({
    ...message(commandId),
    origin: {
      actorId: 'user',
      surface: 'switch-web',
      roomId: 'room',
      threadId: null,
      messageId: null,
    },
    body: { type: 'message.retry', messageId: 'm1' },
  });

  it('says it can retry', async () => {
    const { host } = await start('codex');
    expect(host.snapshot().session.capabilities.retry).toBe(true);
  });

  it('runs a failed turn again under the same message, once however often it is asked', async () => {
    const { host, emit, adapter } = await start('codex');
    await host.command(roomMessage('first'));
    await until(() => expect(host.snapshot().turns[0]?.status).toBe('running'));
    emit({
      type: 'turn.completed',
      turnId: 'first',
      outcome: 'error',
      message: 'model',
      usage: [],
    });
    await until(() => expect(host.snapshot().turns[0]?.status).toBe('error'));

    expect((await host.command(retry('again'))).status).toBe('applied');
    // A double press or a reconnect replaying it.
    expect((await host.command(retry('again'))).status).toBe('applied');
    await until(() => expect(adapter.sendTurn).toHaveBeenCalledTimes(2));
    const turns = host.snapshot().turns;
    expect(turns.map((turn) => turn.turnId)).toEqual(['first', 'again']);
    expect(adapter.sendTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ turnId: 'again', text: 'Hello' })
    );
    // The retry repeats nothing in the transcript the person wrote: its turn carries the same text.
    const userItems = host.snapshot().items.filter((item) => item.kind === 'user-message');
    expect(userItems.map((item) => item.origin?.messageId)).toEqual(['m1', 'm1']);
  });

  it('runs it again in the host started after a failure took the last one down', async () => {
    const { host, emit, root } = await start('codex');
    await host.command(roomMessage('first'));
    await until(() => expect(host.snapshot().turns[0]?.status).toBe('running'));
    emit({
      type: 'turn.completed',
      turnId: 'first',
      outcome: 'error',
      message: 'model',
      usage: [],
    });
    await until(() => expect(host.snapshot().turns[0]?.status).toBe('error'));
    await host.shutdown();

    const next = setup('codex');
    const recovered = await startHost(root, next.config, next.adapter);
    hosts.push(recovered);
    await until(() => expect(recovered.snapshot().session.status).toBe('ready'));
    // Relayed as the current generation, which the shared host fills in.
    const command = { ...retry('again'), epoch: recovered.snapshot().session.epoch };
    expect((await recovered.command(command)).status).toBe('applied');
    await until(() => expect(next.adapter.sendTurn).toHaveBeenCalledTimes(1));
  });

  it('runs a message again after its retry failed too, going by its latest turn', async () => {
    const { host, emit, adapter } = await start('codex');
    await host.command(roomMessage('first'));
    await until(() => expect(host.snapshot().turns[0]?.status).toBe('running'));
    emit({
      type: 'turn.completed',
      turnId: 'first',
      outcome: 'error',
      message: 'model',
      usage: [],
    });
    await until(() => expect(host.snapshot().turns[0]?.status).toBe('error'));
    expect((await host.command(retry('again'))).status).toBe('applied');
    await until(() => expect(host.snapshot().turns[1]?.status).toBe('running'));
    // While the retry runs, another is refused: its latest turn has not ended.
    await expect(host.command(retry('too-soon'))).rejects.toThrow('SESSION_BUSY');
    emit({
      type: 'turn.completed',
      turnId: 'again',
      outcome: 'error',
      message: 'model',
      usage: [],
    });
    await until(() => expect(host.snapshot().turns[1]?.status).toBe('error'));

    expect((await host.command(retry('third'))).status).toBe('applied');
    await until(() => expect(adapter.sendTurn).toHaveBeenCalledTimes(3));
    expect(host.snapshot().turns.map((turn) => turn.turnId)).toEqual(['first', 'again', 'third']);
  });

  it('refuses to run again a turn still going, or a message it never worked on', async () => {
    const { host } = await start('codex');
    await expect(host.command(retry('nothing'))).rejects.toThrow('NOT_FOUND');
    await host.command(roomMessage('first'));
    await until(() => expect(host.snapshot().turns[0]?.status).toBe('running'));
    await expect(host.command(retry('busy'))).rejects.toThrow('SESSION_BUSY');
  });
});

it("tells the turn's room once when the host died mid-turn, however often it restarts", async () => {
  const replies: RoomReply[] = [];
  const reply = async (posted: RoomReply) => {
    replies.push(posted);
  };
  const { root, host } = await startReplying(reply);
  await host.command(roomMessage('cut-off', 'thread-1'));
  await waitFor(() =>
    expect(host.snapshot().turns.find((turn) => turn.turnId === 'cut-off')?.status).toBe('running')
  );
  // The process dies here: no shutdown, so the journal still says "running".
  const after = await startReplying(reply, root);
  await waitFor(() => expect(replies).toHaveLength(1));
  expect(replies[0]).toEqual({
    roomId: 'room',
    threadId: 'thread-1',
    body: RESTARTED_REPLY,
    once: { afterMessageId: 'message-cut-off' },
    restartTurnId: 'cut-off',
  });
  expect(after.host.snapshot().turns.find((turn) => turn.turnId === 'cut-off')?.status).toBe(
    'interrupted'
  );
  await startReplying(reply, root);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(replies).toHaveLength(1);
});

/**
 * A room as the parent's `once` check sees it: a reply already there is
 * answered `already` and not posted again.
 */
function roomWithCheck() {
  const room: RoomReply[] = [];
  const has = (posted: RoomReply) =>
    room.some((line) => line.threadId === posted.threadId && line.body === posted.body);
  return { room, has };
}

async function restartRecords(root: string) {
  const lines = (await readFile(join(root, 'inbox.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return lines.filter((record) => record.type === 'restart-reply');
}

async function cutOff(reply: (posted: RoomReply) => Promise<RoomReplyOutcome | void>) {
  const { root, host } = await startReplying(reply, undefined, [10, 10]);
  await host.command(roomMessage('cut-off', 'thread-1'));
  await waitFor(() =>
    expect(host.snapshot().turns.find((turn) => turn.turnId === 'cut-off')?.status).toBe('running')
  );
  return root;
}

it('posts the restart line once when a post went through but its answer was lost, then retried', async () => {
  const { room, has } = roomWithCheck();
  let calls = 0;
  const reply = async (posted: RoomReply): Promise<RoomReplyOutcome> => {
    calls++;
    if (posted.once && has(posted)) return 'already';
    room.push(posted);
    if (calls === 1) throw new Error('The session host did not answer in time.');
    return 'posted';
  };
  const root = await cutOff(async () => {});
  const after = await startReplying(reply, root, [10, 10]);
  await after.host.restartRepliesSettled();
  expect(calls).toBe(2);
  expect(room).toHaveLength(1);
  expect(await restartRecords(root)).toEqual([
    { type: 'restart-reply', commandId: 'cut-off', state: 'pending' },
    { type: 'restart-reply', commandId: 'cut-off', state: 'sent' },
  ]);
});

it('retries a restart line that failed, and posts nothing blind while the room cannot be checked', async () => {
  const room: RoomReply[] = [];
  let calls = 0;
  const reply = async (posted: RoomReply): Promise<RoomReplyOutcome> => {
    calls++;
    if (calls < 3) throw new Error('Could not check the room first: down');
    room.push(posted);
    return 'posted';
  };
  const root = await cutOff(async () => {});
  const after = await startReplying(reply, root, [10, 10]);
  await after.host.restartRepliesSettled();
  expect(calls).toBe(3);
  expect(room).toHaveLength(1);
});

it('tries an unconfirmed restart line again on the next start, and never posts it twice', async () => {
  const { room, has } = roomWithCheck();
  const root = await cutOff(async () => {});
  // First start after the cut: every try fails, so the line stays pending.
  const failing = await startReplying(
    async () => {
      throw new Error('Switch is unreachable');
    },
    root,
    [10, 10]
  );
  await failing.host.restartRepliesSettled();
  expect((await restartRecords(root)).map((record) => record.state)).toEqual(['pending']);
  // Next start: the turn already reads "interrupted", but the line is still owed.
  let calls = 0;
  const reply = async (posted: RoomReply): Promise<RoomReplyOutcome> => {
    calls++;
    if (posted.once && has(posted)) return 'already';
    room.push(posted);
    return 'posted';
  };
  const second = await startReplying(reply, root, [10, 10]);
  await second.host.restartRepliesSettled();
  expect(room).toHaveLength(1);
  const third = await startReplying(reply, root, [10, 10]);
  await third.host.restartRepliesSettled();
  expect(calls).toBe(1);
  expect(room).toHaveLength(1);
});

it('gives up a restart line Switch never takes after 3 starts, and stops waking the session for it', async () => {
  // A room the agent has since left: Core refuses every post with
  // "Agent is not a member of this room" (core/switch_core room service).
  let calls = 0;
  const refused = async (): Promise<RoomReplyOutcome> => {
    calls++;
    throw new Error('Agent is not a member of this room');
  };
  const root = await cutOff(async () => {});
  for (let start = 1; start <= RESTART_REPLY_ROUNDS; start++) {
    const host = await startReplying(refused, root, [10, 10]);
    await host.host.restartRepliesSettled();
    expect(calls).toBe(start * 3);
    expect(restartReplyGivenUp(await restartReplyRounds(root), 'cut-off')).toBe(
      start === RESTART_REPLY_ROUNDS
    );
  }
  // The next start neither tries again nor counts as owing a line.
  const after = await startReplying(refused, root, [10, 10]);
  await after.host.restartRepliesSettled();
  expect(calls).toBe(RESTART_REPLY_ROUNDS * 3);
  expect((await restartRecords(root)).map((record) => record.state)).toEqual(['pending']);
});

it('tries an owed restart line again when asked after an outage, once per line at a time', async () => {
  // Switch unreachable for this whole start's round, then back: the watcher
  // reconnects and asks the session to try again.
  let reachable = false;
  const room: RoomReply[] = [];
  let calls = 0;
  const reply = async (posted: RoomReply): Promise<RoomReplyOutcome> => {
    calls++;
    if (!reachable) throw new Error('fetch failed');
    room.push(posted);
    return 'posted';
  };
  const root = await cutOff(async () => {});
  const after = await startReplying(reply, root, [10, 10]);
  await after.host.restartRepliesSettled();
  expect(calls).toBe(3);
  expect(room).toHaveLength(0);

  reachable = true;
  // Asked twice at once: one round of tries, not two.
  expect(after.host.retryOwedRestartReplies()).toBe(1);
  expect(after.host.retryOwedRestartReplies()).toBe(0);
  await after.host.restartRepliesSettled();
  expect(room).toHaveLength(1);
  expect(room[0]?.restartTurnId).toBe('cut-off');
  // Sent now: nothing more is owed.
  expect(after.host.retryOwedRestartReplies()).toBe(0);
});

it('tries the restart line for about 2 minutes in one start by default', () => {
  expect(RESTART_REPLY_RETRY_MS.reduce((total, wait) => total + wait, 0)).toBe(120_000);
});

it('owes the restart line when the provider exits mid-turn on its own, and posts it while the host carries on', async () => {
  const { room, has } = roomWithCheck();
  const reply = async (posted: RoomReply): Promise<RoomReplyOutcome> => {
    if (posted.once && has(posted)) return 'already';
    room.push(posted);
    return 'posted';
  };
  const { root, host, emit } = await startReplying(reply, undefined, [10, 10]);
  await host.command(roomMessage('cut-off', 'thread-1'));
  await waitFor(() =>
    expect(host.snapshot().turns.find((turn) => turn.turnId === 'cut-off')?.status).toBe('running')
  );
  // A clean box stop: the CLI gets SIGTERM with everything else and exits first.
  emit({ type: 'session.exited', reason: 'Terminated' });
  await waitFor(() => expect(room).toHaveLength(1));
  await host.restartRepliesSettled();
  expect(room[0]).toMatchObject({ threadId: 'thread-1', body: RESTARTED_REPLY });
  expect(host.snapshot().turns.find((turn) => turn.turnId === 'cut-off')?.status).toBe(
    'interrupted'
  );
  expect((await restartRecords(root)).map((record) => record.state)).toEqual(['pending', 'sent']);
});

it('posts the owed line on the next start when the box stopped before the host could', async () => {
  const { room, has } = roomWithCheck();
  let calls = 0;
  const reply = async (posted: RoomReply): Promise<RoomReplyOutcome> => {
    calls++;
    if (posted.once && has(posted)) return 'already';
    room.push(posted);
    return 'posted';
  };
  // The first host waits 500 ms before posting, and is shut down well inside that.
  const { root, host, emit } = await startReplying(reply, undefined, [500, 10]);
  await host.command(roomMessage('cut-off', 'thread-1'));
  await waitFor(() =>
    expect(host.snapshot().turns.find((turn) => turn.turnId === 'cut-off')?.status).toBe('running')
  );
  emit({ type: 'session.exited', reason: 'Terminated' });
  await waitFor(async () =>
    expect((await restartRecords(root)).map((record) => record.state)).toEqual(['pending'])
  );
  await host.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(room).toHaveLength(0);
  // The next start finds the turn interrupted but the line still owed.
  const next = await startReplying(reply, root, [10, 10]);
  await waitFor(() => expect(room).toHaveLength(1));
  await next.host.restartRepliesSettled();
  const third = await startReplying(reply, root, [10, 10]);
  await third.host.restartRepliesSettled();
  expect(calls).toBe(1);
  expect(room).toHaveLength(1);
});

it('owes nothing when the session was stopped on purpose', async () => {
  const room: RoomReply[] = [];
  const { root, host } = await startReplying(
    async (posted) => {
      room.push(posted);
    },
    undefined,
    [10, 10]
  );
  await host.command(roomMessage('stopped', 'thread-1'));
  await waitFor(() =>
    expect(host.snapshot().turns.find((turn) => turn.turnId === 'stopped')?.status).toBe('running')
  );
  await host.command({ ...message('stop-it'), body: { type: 'session.stop' } } as Command);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(room.filter((posted) => posted.body === RESTARTED_REPLY)).toHaveLength(0);
  expect(await restartRecords(root)).toEqual([]);
});

it('owes the restart line when the provider reports the turn interrupted without anyone asking (a clean box stop)', async () => {
  const { room, has } = roomWithCheck();
  const reply = async (posted: RoomReply): Promise<RoomReplyOutcome> => {
    if (posted.once && has(posted)) return 'already';
    room.push(posted);
    return 'posted';
  };
  const { root, host, emit } = await startReplying(reply, undefined, [500, 10]);
  await host.command(roomMessage('cut-off', 'thread-1'));
  await waitFor(() =>
    expect(host.snapshot().turns.find((turn) => turn.turnId === 'cut-off')?.status).toBe('running')
  );
  // On SIGTERM the CLI ends its turn as interrupted, and then this host shuts down.
  emit({ type: 'turn.completed', turnId: 'cut-off', outcome: 'interrupted', usage: [] });
  await waitFor(async () =>
    expect((await restartRecords(root)).map((record) => record.state)).toEqual(['pending'])
  );
  await host.shutdown();
  expect(room).toHaveLength(0);
  const next = await startReplying(reply, root, [10, 10]);
  await waitFor(() => expect(room).toHaveLength(1));
  await next.host.restartRepliesSettled();
  expect(room[0]).toMatchObject({ threadId: 'thread-1', body: RESTARTED_REPLY });
});

it('owes nothing for a turn someone interrupted on purpose', async () => {
  const room: RoomReply[] = [];
  const { root, host, emit } = await startReplying(
    async (posted) => {
      room.push(posted);
    },
    undefined,
    [10, 10]
  );
  await host.command(roomMessage('asked', 'thread-1'));
  await waitFor(() =>
    expect(host.snapshot().turns.find((turn) => turn.turnId === 'asked')?.status).toBe('running')
  );
  await host.command({
    ...message('interrupt'),
    body: { type: 'turn.interrupt', turnId: 'asked' },
  } as Command);
  emit({ type: 'turn.completed', turnId: 'asked', outcome: 'interrupted', usage: [] });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(room.filter((posted) => posted.body === RESTARTED_REPLY)).toHaveLength(0);
  expect(await restartRecords(root)).toEqual([]);
});

/**
 * The journal B's host wrote on 26 Oct (11:06Z) for a turn cut
 * off when B's pod was deleted: running, the assistant's first message and a
 * tool started, then interrupted with the tool never finished, and nothing
 * after it until the next start. The provider side of that: on SIGTERM the
 * CLI ends its turn as interrupted while the host is going down.
 */
it("owes and posts the line for the event sequence B's host recorded on a clean stop (replayed from the journal)", async () => {
  const recorded = JSON.parse(
    await readFile(
      join(import.meta.dirname, '../testing/fixtures/r5-recheck-b-cut-off-turn.json'),
      'utf8'
    )
  ) as {
    body: {
      type: string;
      status?: string;
      item?: { kind: string; status: string; text: string; title: string };
    };
  }[];
  const { room, has } = roomWithCheck();
  const reply = async (posted: RoomReply): Promise<RoomReplyOutcome> => {
    if (posted.once && has(posted)) return 'already';
    room.push(posted);
    return 'posted';
  };
  const { root, host, emit, adapter } = await startReplying(reply, undefined, [10, 10]);
  await host.command(roomMessage('cut-off', 'thread-1'));
  await waitFor(() =>
    expect(host.snapshot().turns.find((turn) => turn.turnId === 'cut-off')?.status).toBe('running')
  );
  // What the provider said before the stop, as the journal shows: the first message, then a tool starting.
  const message = recorded.find(
    (r) => r.body.item?.kind === 'assistant-message' && r.body.item.status === 'completed'
  )!;
  const tool = recorded.find((r) => r.body.item?.kind === 'tool-activity')!;
  emit({
    type: 'item.completed',
    turnId: 'cut-off',
    item: {
      id: 'msg',
      type: 'assistant_message',
      status: 'completed',
      title: '',
      text: message.body.item!.text,
    },
  });
  emit({
    type: 'item.started',
    turnId: 'cut-off',
    item: { id: 'tool', type: 'tool_call', status: 'in_progress', title: tool.body.item!.title },
  });
  // The box stops: the CLI ends the turn interrupted while this host shuts down.
  vi.mocked(adapter.stopSession).mockImplementation(async () => {
    emit({ type: 'turn.completed', turnId: 'cut-off', outcome: 'interrupted', usage: [] });
    emit({ type: 'session.exited', reason: 'Terminated' });
  });
  await host.shutdown();
  // The host's own journal now ends the way B's did: interrupted, with the tool never finished.
  const ended = (await readFile(join(root, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).body);
  const turnStates = ended
    .filter((b) => b.type === 'turn.upsert' && b.turnId === 'cut-off')
    .map((b) => b.status);
  expect(turnStates.slice(-2)).toEqual(
    recorded.filter((r) => r.body.type === 'turn.upsert').map((r) => r.body.status)
  );
  expect((await restartRecords(root)).map((record) => record.state)).toEqual(['pending']);
  expect(room).toHaveLength(0);
  const next = await startReplying(reply, root, [10, 10]);
  await waitFor(() => expect(room).toHaveLength(1));
  await next.host.restartRepliesSettled();
  expect(room[0]).toMatchObject({ threadId: 'thread-1', body: RESTARTED_REPLY });
});

it('owes nothing when its supervisor stopped it on purpose (the agent turned off, a new build or definition)', async () => {
  const room: RoomReply[] = [];
  const { root, host, emit, adapter } = await startReplying(
    async (posted) => {
      room.push(posted);
    },
    undefined,
    [10, 10]
  );
  await host.command(roomMessage('stopped-on-purpose', 'thread-1'));
  await waitFor(() =>
    expect(host.snapshot().turns.find((turn) => turn.turnId === 'stopped-on-purpose')?.status).toBe(
      'running'
    )
  );
  await markStopAsked(root);
  vi.mocked(adapter.stopSession).mockImplementation(async () => {
    emit({
      type: 'turn.completed',
      turnId: 'stopped-on-purpose',
      outcome: 'interrupted',
      usage: [],
    });
    emit({ type: 'session.exited', reason: 'Terminated' });
  });
  await host.shutdown();
  expect(await restartRecords(root)).toEqual([]);
  // The next start clears the mark and owes nothing.
  const next = await startReplying(
    async (posted) => {
      room.push(posted);
    },
    root,
    [10, 10]
  );
  await next.host.restartRepliesSettled();
  expect(room.filter((posted) => posted.body === RESTARTED_REPLY)).toHaveLength(0);
  expect(await stopWasAsked(root)).toBe(false);
});

it('owes nothing for a turn ended by a person cancelling an approval', async () => {
  const room: RoomReply[] = [];
  const { root, host, emit } = await startReplying(
    async (posted) => {
      room.push(posted);
    },
    undefined,
    [10, 10]
  );
  await host.command(roomMessage('needs-approval', 'thread-1'));
  await waitFor(() =>
    expect(host.snapshot().turns.find((turn) => turn.turnId === 'needs-approval')?.status).toBe(
      'running'
    )
  );
  emit({
    type: 'request.opened',
    turnId: 'needs-approval',
    requestId: 'approve-1',
    requestType: 'tool_approval',
    title: 'Run it?',
    options: [
      { decision: 'accept', label: 'Yes' },
      { decision: 'cancel', label: 'Cancel' },
    ],
  });
  await waitFor(() => expect(host.snapshot().requests[0]?.state).toBe('open'));
  const request = host.snapshot().requests[0]!;
  const cancel =
    request.content.kind === 'approval'
      ? request.content.options.find((o) => o.label === 'Cancel')
      : undefined;
  expect(cancel).toBeDefined();
  await host.command({
    ...message('answer'),
    body: {
      type: 'request.answer',
      requestId: request.requestId,
      expectedRevision: request.revision,
      answer: { kind: 'approval', optionId: cancel!.optionId },
    },
  } as Command);
  emit({ type: 'turn.completed', turnId: 'needs-approval', outcome: 'interrupted', usage: [] });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await restartRecords(root)).toEqual([]);
  expect(room.filter((posted) => posted.body === RESTARTED_REPLY)).toHaveLength(0);
});

it('clears the asked-for mark on every start, even one with nothing to recover', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sdk-host-test-'));
  roots.push(dir);
  await markStopAsked(dir);
  const { host } = await startReplying(async () => {}, dir, [10, 10]);
  await host.restartRepliesSettled();
  expect(await stopWasAsked(dir)).toBe(false);
});

it('after a force-kill and a start on a new build, posts the owed line at start, before any message', async () => {
  const { room, has } = roomWithCheck();
  const reply = async (posted: RoomReply): Promise<RoomReplyOutcome> => {
    if (posted.once && has(posted)) return 'already';
    room.push(posted);
    return 'posted';
  };
  const { root, host } = await startReplying(reply, undefined, [10, 10]);
  await host.command(roomMessage('upgrade-cut', 'thread-1'));
  await waitFor(() =>
    expect(host.snapshot().turns.find((turn) => turn.turnId === 'upgrade-cut')?.status).toBe(
      'running'
    )
  );
  // The old box is force-killed before the provider can report anything: the journal still says running.
  // The new build's controller found no live host to stop (a new box starts with none), so no mark.
  const started = Date.now();
  const next = await startReplying(reply, root, [10, 10]);
  await waitFor(() => expect(room).toHaveLength(1));
  await next.host.restartRepliesSettled();
  expect(Date.now() - started).toBeLessThan(120_000);
  expect(room[0]).toMatchObject({ threadId: 'thread-1', body: RESTARTED_REPLY });
});
