import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command, Session } from '@switch-console/shared/session-v1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SteerNotSentError } from '../adapter';
import type { ProviderAdapter } from '../adapter';
import type { ProviderRuntimeEvent } from '../events';
import { abandonWaits, announcing, changed, until } from '../testing/until';
import { HostedSession } from './session-host';

// The waits have no deadline of their own (see `until`), so this is the one
// clock: long enough for a slow disk, short enough that a host that never
// gets there still fails.
vi.setConfig({ testTimeout: 30_000 });

/** A host that tells `until` each time it calls its provider or publishes an event. */
async function startHost(
  ...[root, config, adapter]: Parameters<typeof HostedSession.start>
): Promise<HostedSession> {
  const host = await HostedSession.start(root, config, announcing(adapter));
  host.onPublished(changed);
  return host;
}

type SteerMode = 'steer' | 'refuse' | 'adopt' | 'unknown';

/**
 * A provider double whose turn stays open until the test completes it, so a
 * second message can be sent while the first turn is still running — the
 * moment steering exists for. In 'steer' mode a message for another turn is
 * folded into the open one, as Claude Code, Codex and OpenCode do; 'refuse'
 * throws, as a provider does when its running turn cannot take the message
 * after all; 'adopt' starts the message as a turn of its own right away, the
 * fallback Codex takes when a steer is refused.
 */
function setup(options: { steering: boolean; steerMode?: SteerMode }) {
  let listener: (event: ProviderRuntimeEvent) => void = () => {};
  let live = false;
  const emit = (event: Record<string, unknown>) =>
    listener({
      ...event,
      provider: 'claude',
      sessionId: 'session',
      eventId: randomUUID(),
      createdAt: new Date().toISOString(),
    } as ProviderRuntimeEvent);
  const sent: string[] = [];
  let openTurn: string | null = null;
  const steerMode = options.steerMode ?? 'steer';
  const adapter: ProviderAdapter = {
    provider: 'claude',
    capabilities: {
      resume: true,
      steering: options.steering,
      approvals: true,
      userInput: true,
      modelSwitchInSession: false,
    },
    startSession: vi.fn(async () => {
      live = true;
      emit({ type: 'session.state.changed', status: 'ready' });
      return { provider: 'claude' as const, sessionId: 'session', nativeSessionId: 'native' };
    }),
    sendTurn: vi.fn(async (input) => {
      sent.push(input.turnId);
      if (openTurn !== null && input.turnId !== openTurn) {
        if (steerMode === 'refuse')
          throw new SteerNotSentError('the running turn refused the message');
        if (steerMode === 'unknown') throw new Error('connection dropped');
        if (steerMode === 'adopt') return { turnId: input.turnId };
        return { turnId: input.turnId, steeredInto: openTurn };
      }
      openTurn = input.turnId;
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
        input: options.steering ? 'steer' : 'queue',
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
  return {
    adapter,
    config,
    sent,
    /** Ends the open turn the way a provider does when its work is done. */
    complete(turnId: string) {
      if (openTurn === turnId) openTurn = null;
      emit({ type: 'turn.completed', turnId, outcome: 'completed', usage: [] });
    },
  };
}

function message(commandId: string, delivery: 'queue' | 'steer'): Command {
  return {
    contractVersion: 1,
    commandId,
    sessionId: 'session',
    epoch: 'epoch',
    origin: { actorId: 'user', surface: 'console', roomId: null, threadId: null, messageId: null },
    body: {
      type: 'message.send',
      delivery,
      text: `text of ${commandId}`,
      attachments: [],
    },
  };
}

describe('mid-turn steering', () => {
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

  async function start(options: { steering: boolean; steerMode?: SteerMode }) {
    const root = await mkdtemp(join(tmpdir(), 'switch-steering-'));
    roots.push(root);
    const fixture = setup(options);
    const host = await startHost(root, fixture.config, fixture.adapter);
    hosts.push(host);
    await until(() => expect(host.snapshot().session.status).toBe('ready'));
    return { ...fixture, root, host };
  }

  it('steers a message sent mid-turn into the running turn', async () => {
    const { host, sent, complete } = await start({ steering: true });
    expect((await host.command(message('first', 'queue'))).status).toBe('applied');
    await until(() => expect(host.snapshot().turns[0]?.status).toBe('running'));

    const steered = await host.command(message('correction', 'steer'));

    expect(steered.status).toBe('applied');
    // The provider was handed the message while 'first' was still open, and
    // no second turn was ever published for it.
    expect(sent).toEqual(['first', 'correction']);
    expect(host.snapshot().turns.map((turn) => turn.turnId)).toEqual(['first']);
    const item = host.snapshot().items.find((entry) => entry.itemId === 'user-correction');
    expect(item?.turnId).toBe('first');
    expect(item?.title).toBe('Steered into the running turn');

    complete('first');
    await until(() => expect(host.snapshot().turns[0]?.status).toBe('completed'));
    // Finishing the turn does not send the steered message again as a turn.
    expect(sent).toEqual(['first', 'correction']);
    expect(host.snapshot().turns).toHaveLength(1);
  });

  it('queues a steer when its authorized turn is no longer active', async () => {
    const { host, sent, complete } = await start({ steering: true });
    await host.command(message('first', 'queue'));
    await until(() => expect(host.snapshot().turns[0]?.status).toBe('running'));
    const stale = message('correction', 'steer');
    await host.command(stale, 'previous-turn');
    expect(sent).toHaveLength(1);
    expect(host.snapshot().turns.find((turn) => turn.turnId === 'correction')?.status).toBe(
      'queued'
    );
    complete('first');
    await until(() => expect(sent).toHaveLength(2));
  });

  it('runs a steered message as the next turn when no turn is running', async () => {
    const { host, sent } = await start({ steering: true });

    const sentCommand = await host.command(message('only', 'steer'));

    expect(sentCommand.status).toBe('applied');
    await until(() => expect(host.snapshot().turns[0]?.status).toBe('running'));
    expect(host.snapshot().turns[0]?.turnId).toBe('only');
    expect(sent).toEqual(['only']);
    const item = host.snapshot().items.find((entry) => entry.itemId === 'user-only');
    expect(item?.turnId).toBe('only');
    expect(item?.title).toBe('');
  });

  it('queues the message when the provider refuses the steer', async () => {
    const { host, sent, complete } = await start({ steering: true, steerMode: 'refuse' });
    await host.command(message('first', 'queue'));
    await until(() => expect(host.snapshot().turns[0]?.status).toBe('running'));

    const refused = await host.command(message('correction', 'steer'));

    expect(refused.status).toBe('applied');
    expect(host.snapshot().notices.some((notice) => notice.code === 'STEERING_FALLBACK')).toBe(
      true
    );
    // The message waits as a queued turn of its own, delivered exactly once:
    // the refused attempt and the queued turn's start are its two sends.
    expect(host.snapshot().turns.find((turn) => turn.turnId === 'correction')?.status).toBe(
      'queued'
    );
    complete('first');
    await until(() =>
      expect(host.snapshot().turns.find((turn) => turn.turnId === 'correction')?.status).toBe(
        'running'
      )
    );
    expect(sent).toEqual(['first', 'correction', 'correction']);
  });

  it('does not resend a steer whose provider outcome is unknown', async () => {
    const { host, sent, complete } = await start({ steering: true, steerMode: 'unknown' });
    await host.command(message('first', 'queue'));
    await until(() => expect(host.snapshot().turns[0]?.status).toBe('running'));
    const result = await host.command(message('correction', 'steer'));
    expect(result.status).toBe('unknown');
    expect(host.snapshot().turns.find((turn) => turn.turnId === 'correction')).toBeUndefined();
    complete('first');
    await until(() => expect(host.snapshot().turns[0]?.status).toBe('completed'));
    expect(sent).toEqual(['first', 'correction']);
  });

  it('adopts the turn a provider starts instead of steering', async () => {
    const { host, sent, complete } = await start({ steering: true, steerMode: 'adopt' });
    await host.command(message('first', 'queue'));
    await until(() => expect(host.snapshot().turns[0]?.status).toBe('running'));

    const adopted = await host.command(message('correction', 'steer'));

    expect(adopted.status).toBe('applied');
    expect(host.snapshot().turns.find((turn) => turn.turnId === 'correction')?.status).toBe(
      'queued'
    );
    const item = host.snapshot().items.find((entry) => entry.itemId === 'user-correction');
    expect(item?.turnId).toBe('correction');
    expect(item?.title).toBe('Queued behind the running turn');

    complete('first');
    complete('correction');
    await until(() =>
      expect(host.snapshot().turns.find((turn) => turn.turnId === 'correction')?.status).toBe(
        'completed'
      )
    );
    // The host never sent the adopted message again.
    expect(sent).toEqual(['first', 'correction']);
  });

  it('refuses a steered message for a provider that cannot steer', async () => {
    const { host, sent } = await start({ steering: false });
    await host.command(message('first', 'queue'));
    await until(() => expect(host.snapshot().turns[0]?.status).toBe('running'));

    await expect(host.command(message('correction', 'steer'))).rejects.toThrow(
      'UNSUPPORTED_CAPABILITY: the selected provider cannot steer a running turn.'
    );
    expect(sent).toEqual(['first']);
    expect(host.snapshot().turns.map((turn) => turn.turnId)).toEqual(['first']);
  });

  it('keeps queueing behind a running turn on a provider that cannot steer', async () => {
    const { host, sent, complete } = await start({ steering: false });
    await host.command(message('first', 'queue'));
    await until(() => expect(host.snapshot().turns[0]?.status).toBe('running'));

    const queued = await host.command(message('second', 'queue'));

    expect(queued.status).toBe('applied');
    expect(host.snapshot().turns.find((turn) => turn.turnId === 'second')?.status).toBe('queued');
    expect(sent).toEqual(['first']);
    complete('first');
    await until(() => expect(sent).toEqual(['first', 'second']));
    await until(() =>
      expect(host.snapshot().turns.find((turn) => turn.turnId === 'second')?.status).toBe('running')
    );
  });

  it('does not deliver a steered message again after a host restart', async () => {
    const { root, host, sent } = await start({ steering: true });
    await host.command(message('first', 'queue'));
    await until(() => expect(host.snapshot().turns[0]?.status).toBe('running'));
    await host.command(message('correction', 'steer'));
    expect(sent).toEqual(['first', 'correction']);
    await host.shutdown();
    hosts.splice(hosts.indexOf(host), 1);

    const next = setup({ steering: true });
    const recovered = await startHost(root, next.config, next.adapter);
    hosts.push(recovered);

    // The steered command was finished when the host stopped, so recovery
    // leaves it applied and never hands it to the provider again. The turn
    // it steered into was still running, so that turn reads interrupted.
    expect(next.sent).toEqual([]);
    expect(
      recovered.snapshot().commandStatuses.find((status) => status.commandId === 'correction')
        ?.status
    ).toBe('applied');
    expect(recovered.snapshot().turns[0]?.status).toBe('interrupted');
  });
});
