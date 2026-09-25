import {
  liveSupervisor,
  SessionHostFailedError,
  SessionUnavailableError,
  sharedSessionRoot,
  type SessionRequest,
} from '@switch-console/agent-providers';
import {
  commandStatusSchema,
  snapshotSchema,
  type ClientCommand,
  type CommandStatus,
} from '@switch-console/shared/session-v1';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { hydrateSession } from '@main/core/sessions/operations/hydrateSession';
import { cloudControl, isCloudAgent, runCloudSessionOperation } from './cloud-control';
import { localSessionLinks } from './local-host';
import { withSidecar } from './sidecar-control';

/**
 * Commands for a shared session, sent to its host directly.
 *
 * A local session's host is Console's child; a remote one's is a child of
 * the agent's sidecar, which Console reaches over SSH, or of a cloud worker,
 * reached through its Switch server's relay. Either way the command goes down
 * the host's IPC pipe and the host answers with what it recorded. A host that parked itself after sitting idle is
 * started again and the command sent once it is back.
 */

export class CommandNotRecordedError extends Error {
  constructor(commandId: string) {
    super(`The session host has not recorded command ${commandId}.`);
    this.name = 'CommandNotRecordedError';
  }
}

/** How long a command waits for a host that is still starting. */
const HOST_WAIT_MS = 30000;

async function isLocal(agentId: string): Promise<boolean> {
  const agent = await getAgentById(agentId);
  if (!agent?.switchAgentId) throw new Error('This agent is not linked to Switch.');
  return !(await getAgentLocation(agent)).sshHost;
}

/** Ask the session's host, wherever it runs. */
export async function askHost(
  agentId: string,
  sessionId: string,
  request: SessionRequest
): Promise<unknown> {
  if (isCloudAgent(agentId)) return (await cloudControl(agentId)).request(sessionId, request);
  if (await isLocal(agentId)) {
    const root = sharedSessionRoot(sessionId);
    // Waits for a host that is starting, not for one nothing is running.
    const running = await liveSupervisor(root);
    return localSessionLinks.request(root, request, running ? HOST_WAIT_MS : 0);
  }
  return withSidecar(agentId, (client) => client.request(sessionId, request));
}

export async function submitSessionCommand(
  agentId: string,
  command: ClientCommand
): Promise<CommandStatus> {
  const request: SessionRequest = {
    type: 'command',
    requesterName: null,
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
  };
  try {
    return commandStatusSchema.parse(await askHost(agentId, command.sessionId, request));
  } catch (error) {
    // A host that failed is started again too: sending it something is the
    // user asking for it, and whatever stopped it may have been fixed.
    if (!(error instanceof SessionUnavailableError || error instanceof SessionHostFailedError))
      throw error;
  }
  try {
    if (isCloudAgent(agentId))
      await runCloudSessionOperation(agentId, command.sessionId, 'restart');
    else await hydrateSession(command.sessionId);
  } catch (error) {
    throw new Error(
      `The session is not running and could not be started again: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return commandStatusSchema.parse(await askHost(agentId, command.sessionId, request));
}

/** What the session's host last recorded for a command. */
export async function sessionCommandStatus(
  agentId: string,
  sessionId: string,
  commandId: string
): Promise<CommandStatus> {
  const snapshot = snapshotSchema.parse(await askHost(agentId, sessionId, { type: 'snapshot' }));
  const status = snapshot.commandStatuses.find((entry) => entry.commandId === commandId);
  if (!status) throw new CommandNotRecordedError(commandId);
  return status;
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
