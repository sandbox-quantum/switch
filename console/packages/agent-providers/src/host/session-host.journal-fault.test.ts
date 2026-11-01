import { randomUUID } from 'node:crypto';
import type * as NodeFsPromises from 'node:fs/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command, Session } from '@switch-console/shared/session-v1';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderAdapter } from '../adapter';
import type { ProviderRuntimeEvent } from '../events';
import { abandonWaits, announcing, changed, until } from '../testing/until';
import { Journal } from './journal';
import { HostedSession } from './session-host';

// The disk refuses the one write that records a turn as cancelled.
const disk = vi.hoisted(() => ({ refuse: null as string | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  const open: typeof actual.open = async (...args) => {
    const file = await actual.open(...args);
    return new Proxy(file, {
      get(target, key) {
        if (key === 'writeFile')
          return async (data: string) => {
            if (disk.refuse !== null && String(data).includes(disk.refuse))
              throw new Error('ENOSPC: no space left on device');
            return target.writeFile(data);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return { ...actual, open };
});

vi.setConfig({ testTimeout: 30_000 });

/**
 * `vi.waitFor`, for state the host writes to disk without telling anyone,
 * which `until` would never look at again.
 */
function poll<T>(check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(check, { timeout: 10_000 });
}

const roots: string[] = [];
const hosts: HostedSession[] = [];
afterEach(async () => {
  disk.refuse = null;
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

function command(commandId: string, body: Command['body']): Command {
  return {
    contractVersion: 1,
    commandId,
    sessionId: 'session',
    epoch: 'epoch',
    origin: {
      actorId: '@person:test',
      surface: 'switch-web',
      roomId: 'room',
      threadId: null,
      messageId: `message-${commandId}`,
    },
    body,
  };
}
const roomMessage = (commandId: string) =>
  command(commandId, { type: 'message.send', delivery: 'queue', text: 'Hello', attachments: [] });

async function inboxRecords(root: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(root, 'inbox.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

it('stops the queue when the cancellation it took a message out for cannot be recorded', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const root = await mkdtemp(join(tmpdir(), 'sdk-cancel-fault-'));
  roots.push(root);
  const { adapter, config, emit } = setup('claude');
  const host = await HostedSession.start(root, config, announcing(adapter));
  host.onPublished(changed);
  hosts.push(host);
  await until(() => expect(host.snapshot().session.status).toBe('ready'));
  for (const id of ['a', 'b', 'c']) await host.command(roomMessage(id));
  await until(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());

  disk.refuse = '"status":"cancelled"';
  const outcome = await host
    .command(command('cancel-b', { type: 'turn.cancel', turnId: 'b' }))
    .then(
      (status) => status.status,
      () => 'threw'
    );
  expect(outcome).not.toBe('rejected');
  expect(host.snapshot().commandStatuses.find((s) => s.commandId === 'cancel-b')?.status).not.toBe(
    'rejected'
  );
  // The host is in fault: it takes no more work.
  await expect(host.command(roomMessage('d'))).rejects.toThrow('ENOSPC');

  // The turn before ends; the host records it, then a later provider event,
  // in order. Once that later one is on disk, a C the host had sent would be too.
  emit({ type: 'turn.completed', turnId: 'a', outcome: 'completed', usage: [] });
  emit({ type: 'session.started', nativeSessionId: 'after-completion' });
  await poll(async () =>
    expect(await inboxRecords(root)).toContainEqual({
      type: 'native',
      nativeSessionId: 'after-completion',
    })
  );
  expect(adapter.sendTurn).toHaveBeenCalledOnce();
  expect(await inboxRecords(root)).not.toContainEqual({ type: 'dispatched', commandId: 'c' });
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});

it('sends nothing once a cancellation it cannot record faults the host during a dispatch', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  // `c` is next after `a`; its dispatch record waits on the disk until released.
  const original = Journal.prototype.append;
  const dispatch = { reached: false, written: false };
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  const append = vi.spyOn(Journal.prototype, 'append').mockImplementation(async function (
    this: Journal<unknown>,
    value: unknown
  ) {
    const record = value as { type?: string; commandId?: string };
    const isDispatch = record.type === 'dispatched' && record.commandId === 'c';
    if (isDispatch) {
      dispatch.reached = true;
      await held;
    }
    await original.call(this, value);
    if (isDispatch) dispatch.written = true;
  });
  try {
    const root = await mkdtemp(join(tmpdir(), 'sdk-dispatch-fault-'));
    roots.push(root);
    const { adapter, config, emit } = setup('claude');
    const host = await HostedSession.start(root, config, announcing(adapter));
    host.onPublished(changed);
    hosts.push(host);
    await until(() => expect(host.snapshot().session.status).toBe('ready'));
    for (const id of ['a', 'c', 'b']) await host.command(roomMessage(id));
    await until(() => expect(adapter.sendTurn).toHaveBeenCalledOnce());
    emit({ type: 'turn.completed', turnId: 'a', outcome: 'completed', usage: [] });
    await poll(() => expect(dispatch.reached).toBe(true));

    // While `c`'s dispatch is being written, cancelling `b` faults the host.
    disk.refuse = '"status":"cancelled"';
    await host.command(command('cancel-b', { type: 'turn.cancel', turnId: 'b' })).then(
      (status) => status.status,
      () => 'threw'
    );
    await expect(host.command(roomMessage('d'))).rejects.toThrow('ENOSPC');
    release();
    await poll(() => expect(dispatch.written).toBe(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(adapter.sendTurn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalled();
  } finally {
    release();
    append.mockRestore();
    error.mockRestore();
  }
});
