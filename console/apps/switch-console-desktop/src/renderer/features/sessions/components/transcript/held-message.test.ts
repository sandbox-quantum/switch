import {
  type ClientCommand,
  type CommandStatus,
  SessionChatClient,
  type SessionTransport,
} from '@switch-console/shared/session-v1';
import { describe, expect, it } from 'vitest';
import { RpcError, serializeRpcError } from '@shared/lib/ipc/rpc-error';
import {
  deliverHeld,
  heldMessages,
  heldStatusText,
  isWakingError,
  relayRefusalText,
} from './held-message';

function relayError(relayCode: string): RpcError {
  const error = Object.assign(new Error(`Refused: ${relayCode}`), {
    name: 'CloudRelayError',
    relayCode,
    status: 409,
    wakeAvailable: false,
  });
  return new RpcError(serializeRpcError(error));
}

const snapshot = {
  contractVersion: 1,
  throughSequence: 1,
  session: {
    sessionId: 'session-demo',
    agentId: 'agent-demo',
    provider: 'claude',
    hostId: 'host-demo',
    epoch: 'epoch-demo',
    status: 'ready',
    connectivity: 'online',
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
    pendingRequestIds: [],
  },
  turns: [],
  items: [],
  requests: [],
  commandStatuses: [],
  nextPageToken: null,
};

/**
 * A session host behind the relay: it records each command id once, and a
 * reconcile answers from that record, submitting only a command it never got.
 * `refusals` are what the next calls meet before they reach it.
 */
function host() {
  const records = new Map<string, ClientCommand>();
  const arrivals: string[] = [];
  const refusals: Array<'waking' | 'reply-lost'> = [];
  const status = (commandId: string): CommandStatus => ({
    type: 'command.status',
    commandId,
    status: 'accepted',
    code: null,
    message: null,
  });
  const submit = async (command: ClientCommand): Promise<CommandStatus> => {
    const refusal = refusals.shift();
    if (refusal === 'waking') throw relayError('worker_waking');
    arrivals.push(command.commandId);
    if (!records.has(command.commandId)) records.set(command.commandId, command);
    if (refusal === 'reply-lost') throw new Error('The relay reply was lost.');
    return status(command.commandId);
  };
  const transport: SessionTransport = {
    snapshot: async () => structuredClone(snapshot),
    subscribe: () => () => {},
    submit,
    reconcile: async (command) => {
      if (refusals[0] === 'waking') {
        refusals.shift();
        throw relayError('worker_waking');
      }
      return records.has(command.commandId) ? status(command.commandId) : submit(command);
    },
    commandStatus: async (_sessionId, commandId) => {
      if (!records.has(commandId)) throw new Error('Not recorded.');
      return status(commandId);
    },
  };
  return { transport, records, arrivals, refusals };
}

async function connected(transport: SessionTransport): Promise<SessionChatClient> {
  const client = new SessionChatClient('session-demo', transport);
  await client.connect();
  expect(client.getSnapshot().connected).toBe(true);
  return client;
}

describe('a message held while the cloud machine wakes', () => {
  it('keeps a send refused as waking, then delivers it once under its id', async () => {
    const worker = host();
    const client = await connected(worker.transport);
    worker.refusals.push('waking');
    const refused = await client.send('hello', 'held-1', []).catch((error: unknown) => error);
    expect(isWakingError(refused)).toBe(true);
    expect(client.hasPendingCommand()).toBe(true);
    expect(worker.records.size).toBe(0);

    const held = { commandId: 'held-1', text: 'hello', attachments: [] };
    worker.refusals.push('waking');
    const again = await deliverHeld(client, held).catch((error: unknown) => error);
    expect(isWakingError(again)).toBe(true);
    expect(client.hasPendingCommand()).toBe(true);

    const delivered = await deliverHeld(client, held);
    expect(delivered.commandId).toBe('held-1');
    expect([...worker.records.keys()]).toEqual(['held-1']);
    expect(worker.arrivals).toEqual(['held-1']);
    expect(client.hasPendingCommand()).toBe(false);
  });

  it('reconciles a delivery whose reply was lost after the host recorded it', async () => {
    const worker = host();
    const client = await connected(worker.transport);
    worker.refusals.push('reply-lost');
    const lost = await client.send('hello', 'held-2', []).catch((error: unknown) => error);
    expect(isWakingError(lost)).toBe(false);
    expect(client.hasPendingCommand()).toBe(true);

    await deliverHeld(client, { commandId: 'held-2', text: 'hello', attachments: [] });
    expect([...worker.records.keys()]).toEqual(['held-2']);
    expect(worker.arrivals).toEqual(['held-2']);
    expect(client.hasPendingCommand()).toBe(false);
  });

  it('sends a message held before it was ever submitted, and not twice', async () => {
    const worker = host();
    const client = await connected(worker.transport);
    const held = { commandId: 'held-3', text: 'wake up', attachments: [] };

    await deliverHeld(client, held);
    expect([...worker.records.keys()]).toEqual(['held-3']);
    expect(worker.records.get('held-3')?.body).toMatchObject({
      type: 'message.send',
      text: 'wake up',
    });
    expect(client.hasPendingCommand()).toBe(false);

    await deliverHeld(client, held);
    expect(worker.records.size).toBe(1);
  });
});

describe('relay refusals the user has to act on', () => {
  it('says what to do for a stopped machine, a stopped agent and a crashed agent', () => {
    expect(relayRefusalText(relayError('machine_stopped'))).toBe(
      'The owner stopped the cloud machine. Start it in Your Agents, then send again.'
    );
    expect(relayRefusalText(relayError('agent_stopped'))).toBe(
      'This agent is stopped. Start it in Your Agents, then send again.'
    );
    expect(relayRefusalText(relayError('agent_crashed'))).toBe(
      'This agent crashed. Retry it in Your Agents, then send again.'
    );
  });

  it('says what to do for a machine in error', () => {
    expect(relayRefusalText(relayError('machine_error'))).toBe(
      'The cloud machine is in error. Retry it in Your Agents, then send again.'
    );
  });

  it('prefers the server detail for a machine that needs admin attention', () => {
    const error = Object.assign(
      new Error('The cloud machine needs attention. Contact your server administrator.'),
      {
        name: 'CloudRelayError',
        relayCode: 'machine_error',
        status: 409,
        wakeAvailable: false,
      }
    );
    const rpcError = new RpcError(serializeRpcError(error));
    expect(relayRefusalText(rpcError)).toBe(
      'The cloud machine needs attention. Contact your server administrator.'
    );
  });

  it('has nothing to add for any other failure', () => {
    expect(relayRefusalText(relayError('worker_waking'))).toBeNull();
    expect(relayRefusalText(relayError('worker_busy'))).toBeNull();
    expect(relayRefusalText(new Error('machine_stopped'))).toBeNull();
    expect(relayRefusalText(relayError('toString'))).toBeNull();
    expect(isWakingError(new Error('worker_waking'))).toBe(false);
  });
});

describe('what the composer says while it holds a message', () => {
  it('says waking only while the machine is not yet awake', () => {
    expect(heldStatusText('machine')).toMatch(/^Waking…/);
    expect(heldStatusText('machine')).toContain('Keep Switch Console open');
    expect(heldStatusText('session')).not.toContain('Waking');
    expect(heldStatusText('session')).toContain('The machine is awake. Connecting to the session');
  });

  it('says the agent is starting when only the agent starts on a machine already up', () => {
    expect(heldStatusText('agent')).toBe(
      'Starting the agent… Your message is sent when it is ready.'
    );
  });
});

describe('held messages by session', () => {
  it('keeps a held message for its session until it is cleared', () => {
    const held = { commandId: 'held-4', text: 'later', attachments: [] };
    heldMessages.set('session-a', held);
    expect(heldMessages.get('session-a')).toEqual(held);
    expect(heldMessages.get('session-b')).toBeNull();
    heldMessages.set('session-a', null);
    expect(heldMessages.get('session-a')).toBeNull();
  });
});
