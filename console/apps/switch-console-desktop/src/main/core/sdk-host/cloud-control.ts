import { setTimeout as delay } from 'node:timers/promises';
import {
  CloudRelayClient,
  CloudRelayError,
  RELAY_TIMEOUT_MS,
} from '@switch-console/agent-providers';
import type { Attachment } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import {
  GatewayError,
  gatewayFetch,
  gatewayRequest,
} from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import {
  type CloudAgent,
  cloudAgentKey,
  type CloudLaunch,
  cloudLaunchSchema,
  type CloudOperation,
  type CloudOperationOutcome,
  cloudOperationSchema,
  parseCloudAgentKey,
} from '@shared/core/cloud-agents/cloud-agents';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * Console's reach into a cloud agent's worker, through its Switch server.
 *
 * A sidecar is reached over SSH on its control port; a cloud worker accepts no
 * connection, so the same control messages go through the server's relay for
 * the launch. One relay client per launch, made on first use and again after
 * it closes. Transcripts stay on the worker: every snapshot, list and event
 * is asked of it through the relay.
 */

export function isCloudAgent(agentId: string): boolean {
  return parseCloudAgentKey(agentId) !== null;
}

function launchOf(agentId: string): { serverId: string; requestId: string } {
  const key = parseCloudAgentKey(agentId);
  if (!key) throw new Error(`${agentId} is not a cloud agent.`);
  return key;
}

async function serverOf(serverId: string): Promise<SwitchServer> {
  const server = await getServer(serverId);
  if (!server) throw new Error('The Switch server for this cloud agent was removed.');
  return server;
}

function launchPath(requestId: string, rest = ''): string {
  return `/hosted-launches/${encodeURIComponent(requestId)}${rest}`;
}

const clients = new Map<string, CloudRelayClient>();

/** The relay client for this cloud agent's worker, made if there is none. */
export async function cloudControl(agentId: string): Promise<CloudRelayClient> {
  const existing = clients.get(agentId);
  if (existing && !existing.isClosed) return existing;
  const { serverId, requestId } = launchOf(agentId);
  const server = await serverOf(serverId);
  const client = new CloudRelayClient(
    (path, init) =>
      gatewayRequest(server, launchPath(requestId, path), {
        authenticated: true,
        method: init.method,
        body: init.body,
        signal: init.signal,
      }),
    { retryMs: 20_000, timeoutMs: RELAY_TIMEOUT_MS }
  );
  client.onClose(() => {
    if (clients.get(agentId) === client) clients.delete(agentId);
  });
  clients.set(agentId, client);
  return client;
}

export async function listCloudLaunches(server: SwitchServer): Promise<CloudLaunch[]> {
  return z
    .array(cloudLaunchSchema)
    .parse(await (await gatewayFetch(server, '/hosted-launches', { authenticated: true })).json());
}

/**
 * The server's cloud agents with their workers' sessions. A worker that
 * cannot be asked is reported with the relay's code rather than left out, so
 * a sleeping or detached launch reads as such.
 */
export async function listCloudAgents(serverId: string): Promise<CloudAgent[]> {
  const launches = (await listCloudLaunches(await serverOf(serverId))).filter(
    (launch) => launch.agent_id && launch.desired_state !== 'deleted'
  );
  return Promise.all(
    launches.map(async (launch): Promise<CloudAgent> => {
      const key = cloudAgentKey(serverId, launch.request_id);
      if (launch.sleeping)
        return {
          key,
          launch,
          sessions: null,
          problem: {
            code: 'worker_sleeping',
            message: 'The cloud worker is asleep.',
            wakeAvailable: true,
          },
        };
      if (launch.state !== 'ready' && launch.state !== 'running')
        return {
          key,
          launch,
          sessions: null,
          problem: {
            code: 'worker_not_attached',
            message: `The cloud worker is ${launch.state}${launch.error ? `: ${launch.error}` : '.'}`,
            wakeAvailable: launch.state === 'stopped',
          },
        };
      try {
        return { key, launch, sessions: await (await cloudControl(key)).list(), problem: null };
      } catch (error) {
        return {
          key,
          launch,
          sessions: null,
          problem:
            error instanceof CloudRelayError
              ? {
                  code: error.relayCode,
                  message: error.message,
                  wakeAvailable: error.wakeAvailable,
                }
              : {
                  code: 'failed',
                  message: error instanceof Error ? error.message : String(error),
                  wakeAvailable: false,
                },
        };
      }
    })
  );
}

/** Start a sleeping or stopped launch's worker again. */
export async function wakeCloudAgent(agentId: string): Promise<CloudLaunch> {
  const { serverId, requestId } = launchOf(agentId);
  const server = await serverOf(serverId);
  const launch = cloudLaunchSchema.parse(
    await (await gatewayFetch(server, launchPath(requestId), { authenticated: true })).json()
  );
  return cloudLaunchSchema.passthrough().parse(
    await (
      await gatewayFetch(server, launchPath(requestId, '/lifecycle'), {
        authenticated: true,
        method: 'POST',
        body: { action: 'start', revision: launch.revision },
      })
    ).json()
  );
}

const OPERATION_WAIT_MS = 180_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A refusal the server answered, so it holds no operation for this request. */
function isDefiniteRefusal(error: unknown): error is GatewayError {
  return (
    error instanceof GatewayError &&
    (error.kind === 'unauthorized' ||
      (error.kind === 'http' && error.status !== undefined && error.status < 500))
  );
}

/**
 * Ask the worker to start a new session (`start`) or run an existing one
 * again (`restart`), and wait until it says it has. `operationId` is the
 * attempt's identity: after an `unknown` outcome, ask again with the same id
 * and the server returns the operation it already holds instead of queueing
 * another. A start's id is its session id.
 */
export async function runCloudSessionOperation(
  agentId: string,
  sessionId: string,
  operationId: string,
  action: 'start' | 'restart'
): Promise<CloudOperationOutcome> {
  if (action === 'start' && operationId !== sessionId)
    throw new Error('A cloud session start is identified by its session id.');
  const { serverId, requestId } = launchOf(agentId);
  const server = await serverOf(serverId);
  let operation: CloudOperation;
  try {
    operation = cloudOperationSchema.parse(
      await (
        await gatewayFetch(server, launchPath(requestId, '/sessions'), {
          authenticated: true,
          method: 'POST',
          body: { id: operationId, session_id: sessionId, action },
        })
      ).json()
    );
  } catch (error) {
    if (isDefiniteRefusal(error))
      return { state: 'failed', message: error.detail ?? error.message };
    return {
      state: 'unknown',
      message: `The server did not confirm the session ${action}: ${errorMessage(error)}`,
    };
  }
  const deadline = Date.now() + OPERATION_WAIT_MS;
  try {
    while (operation.state === 'queued' || operation.state === 'claimed') {
      if (Date.now() >= deadline)
        return {
          state: 'unknown',
          message: `The cloud worker has not confirmed the session ${action} yet.`,
        };
      await delay(1000);
      operation = cloudOperationSchema.parse(
        await (
          await gatewayFetch(
            server,
            launchPath(requestId, `/sessions/${encodeURIComponent(operationId)}`),
            { authenticated: true }
          )
        ).json()
      );
    }
  } catch (error) {
    return {
      state: 'unknown',
      message: `The session ${action} could not be followed: ${errorMessage(error)}`,
    };
  }
  if (operation.state === 'applied') return { state: 'applied' };
  if (operation.state === 'failed')
    return { state: 'failed', message: operation.error ?? `The session ${action} failed.` };
  return { state: 'unknown', message: `The outcome of the session ${action} is unknown.` };
}

/** Stage a file on the session's worker for the next message to name. */
export async function uploadCloudAttachment(
  agentId: string,
  sessionId: string,
  file: { name: string; mimeType: string; data: string }
): Promise<Attachment> {
  return (await cloudControl(agentId)).uploadAttachment(sessionId, {
    name: file.name,
    mimeType: file.mimeType,
    data: Buffer.from(file.data, 'base64'),
  });
}
