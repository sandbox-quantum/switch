import { setTimeout as delay } from 'node:timers/promises';
import { SessionUnavailableError, sharedSessionRoot } from '@switch-console/agent-providers';
import {
  commandStatusSchema,
  snapshotSchema,
  type ClientCommand,
  type CommandStatus,
} from '@switch-console/shared/session-v1';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { relaySessionCommand } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { hostJournals } from './host-journal';
import { localSessionLinks } from './local-host';

/**
 * Commands for a shared session.
 *
 * A local session's host is Console's child, so a command goes straight down
 * the IPC pipe to it and the host answers with what it recorded. A remote
 * session's command goes by way of Switch, which relays it to the agent's
 * watcher without keeping it, until the sidecar carries it the same way; what
 * became of it is read back from the host's own journal.
 */

export class CommandNotRecordedError extends Error {
  constructor(commandId: string) {
    super(`The session host has not recorded command ${commandId}.`);
    this.name = 'CommandNotRecordedError';
  }
}

async function linked(agentId: string) {
  const agent = await getAgentById(agentId);
  if (!agent?.switchAgentId || !agent.serverId)
    throw new Error('This agent is not linked to a Switch server.');
  const server = await getServer(agent.serverId);
  if (!server) throw new Error('The agent’s Switch server is missing.');
  const local = !(await getAgentLocation(agent)).sshHost;
  return { server, switchAgentId: agent.switchAgentId, local };
}

/** How long a command waits for a local host that is still starting. */
const LOCAL_HOST_WAIT_MS = 30000;

async function toLocalHost(command: ClientCommand): Promise<CommandStatus> {
  try {
    return commandStatusSchema.parse(
      await localSessionLinks.request(
        sharedSessionRoot(command.sessionId),
        {
          type: 'command',
          command: {
            ...command,
            origin: {
              surface: 'console',
              actorId: 'console',
              roomId: null,
              threadId: null,
              messageId: null,
            },
          },
        },
        LOCAL_HOST_WAIT_MS
      )
    );
  } catch (error) {
    if (error instanceof SessionUnavailableError)
      throw new Error(`The session is not running here: ${error.message}`);
    throw error;
  }
}

/** What the session's host last recorded for a command. */
export async function sessionCommandStatus(
  agentId: string,
  sessionId: string,
  commandId: string
): Promise<CommandStatus> {
  if ((await linked(agentId)).local) {
    const root = sharedSessionRoot(sessionId);
    const snapshot = localSessionLinks.ready(root)
      ? snapshotSchema.parse(await localSessionLinks.request(root, { type: 'snapshot' }, 10000))
      : null;
    const status = snapshot?.commandStatuses.find((entry) => entry.commandId === commandId);
    if (!status) throw new CommandNotRecordedError(commandId);
    return status;
  }
  const status = (await hostJournals.tail(agentId, sessionId)).commandStatus(commandId);
  if (!status) throw new CommandNotRecordedError(commandId);
  return status;
}

const CONFIRM_ATTEMPTS = 20;
const CONFIRM_INTERVAL_MS = 250;

/**
 * Send a command and return the host's first word on it. When the host has
 * not recorded it within a few seconds, or its journal cannot be read from
 * here, the answer is `dispatched`: Switch handed it to the watcher, and the
 * transcript shows what follows.
 */
export async function submitSessionCommand(
  agentId: string,
  command: ClientCommand
): Promise<CommandStatus> {
  const { server, switchAgentId, local } = await linked(agentId);
  if (local) return toLocalHost(command);
  await relaySessionCommand(server, switchAgentId, command);
  for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
    try {
      return await sessionCommandStatus(agentId, command.sessionId, command.commandId);
    } catch (error) {
      if (!(error instanceof CommandNotRecordedError)) break;
    }
    await delay(CONFIRM_INTERVAL_MS);
  }
  return {
    type: 'command.status',
    commandId: command.commandId,
    status: 'dispatched',
    code: null,
    message: 'Sent to the session’s host; waiting for it to confirm.',
  };
}

/** The host's record of a command, sending it again if the host never got it. */
export async function reconcileSessionCommand(
  agentId: string,
  command: ClientCommand
): Promise<CommandStatus> {
  try {
    return await sessionCommandStatus(agentId, command.sessionId, command.commandId);
  } catch (error) {
    if (!(error instanceof CommandNotRecordedError)) throw error;
  }
  return submitSessionCommand(agentId, command);
}
