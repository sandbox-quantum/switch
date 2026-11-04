import {
  type CliConversationMode,
  type CliConversationRequest,
  cliConversationFailureSchema,
  cliConversationListSchema,
  deletedCliConversationCopiesSchema,
  EXECUTION_INHERIT_ENV,
  forkedCliConversationSchema,
} from '@switch-console/agent-providers';
import { err, ok, type Result } from '@switch-console/shared';
import type { z } from 'zod';
import { getAgentById } from '@main/core/agents/getAgentById';
import { locationManager } from '@main/core/locations/location-manager';
import type { LocationProvider } from '@main/core/locations/location-provider';
import { resolveSessionEnv } from '@main/core/locations/location-runtime-factory';
import { runHostRequest } from '@main/core/sdk-host/shared-host-deployment';
import { log } from '@main/lib/logger';
import type { CliConversationList } from '@shared/core/sessions/cli-conversations';

/** How long listing may take on the host, its shell setup included. */
const LIST_TIMEOUT_MS = 60_000;
/** How long copying may take on the host: a long conversation is a large file. */
const FORK_TIMEOUT_MS = 120_000;
/** How long removing a session's copies may take on the host. */
const DELETE_TIMEOUT_MS = 60_000;

/** The host ran the command and said why it failed, so its outcome is known. */
class HostRefusedError extends Error {}

/**
 * Sessions whose copy may still be on a location's host, by location id: the
 * copy was asked for and no answer came back (a timeout, a dropped
 * connection), so it may have been made after Console stopped waiting, or
 * removing it failed. Each list or copy in the location tries removing them
 * again. In memory only, so a copy whose session is forgotten across a
 * restart stays; it is still tagged as a copy and hidden from the dialog.
 */
const unsettledCopies = new Map<string, Set<string>>();

/**
 * The conversations started in Claude Code's own CLI in an agent's folder that
 * a new session could continue, read on the machine the agent's sessions run
 * on. Copies Console made, its sessions' own among them, are left out by the
 * host.
 *
 * Only reads the host: on an SSH host without this build's bundle it says so
 * rather than deploying one.
 */
export async function listCliConversations(
  agentId: string
): Promise<Result<CliConversationList, { message: string }>> {
  try {
    const agent = await getAgentById(agentId);
    if (!agent) throw new Error('This agent no longer exists.');
    if (agent.providerId !== 'claude')
      throw new Error('Only Claude Code agents can continue a conversation started in its CLI.');
    const location = locationManager.getLocation(agent.locationId);
    if (!location) throw new Error('Open the agent’s folder in Console first.');
    const request = await conversationRequest(location, { id: 'new-session', title: 'Session' });
    const [list] = await Promise.all([
      runConversationRequest(
        location,
        '--cli-conversations',
        request,
        { deploy: false, timeout: LIST_TIMEOUT_MS },
        cliConversationListSchema
      ),
      removeUnsettledCopies(location),
    ]);
    return ok(list);
  } catch (error) {
    return err({ message: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Copies a conversation started in Claude Code's CLI for `session` to continue,
 * and returns the copy's id. The copy is tagged with the session, so a copy
 * whose session never starts can be removed ({@link discardCliConversationCopies}).
 * Refused while a Claude Code process has the conversation open, or, where
 * Claude Code cannot say, unless the person said it is closed. Part of
 * starting the session, so it deploys this build's bundle to an SSH host that
 * lacks it.
 */
export async function forkCliConversation(
  location: LocationProvider,
  session: { id: string; title: string },
  nativeSessionId: string,
  confirmedClosed: boolean
): Promise<string> {
  const request = await conversationRequest(location, session);
  const [fork] = await Promise.all([
    runConversationRequest(
      location,
      '--fork-cli-conversation',
      { ...request, nativeSessionId, consoleSessionId: session.id, confirmedClosed },
      { deploy: true, timeout: FORK_TIMEOUT_MS },
      forkedCliConversationSchema
    ).catch((error: unknown) => {
      if (!(error instanceof HostRefusedError)) rememberUnsettledCopy(location, session.id);
      throw error;
    }),
    removeUnsettledCopies(location),
  ]);
  return fork.nativeSessionId;
}

/**
 * Removes the copies made for a session that will not run: its copy failed,
 * timed out, or finished after its row was deleted. Only conversations tagged
 * as this session's are removed. Never throws: a removal that fails is
 * logged, and tried again with the location's next list or copy, so it
 * cannot hide why the session did not start.
 */
export async function discardCliConversationCopies(
  location: LocationProvider,
  sessionId: string
): Promise<void> {
  try {
    await deleteCopies(location, sessionId);
  } catch (error) {
    rememberUnsettledCopy(location, sessionId);
    log.warn(
      'Could not remove the copy of a CLI conversation made for a session that did not start',
      {
        event: 'cli_conversation.copy_cleanup',
        stage: 'failed',
        sessionId,
        error: String(error),
      }
    );
  }
}

function rememberUnsettledCopy(location: LocationProvider, sessionId: string): void {
  const sessions = unsettledCopies.get(location.locationId) ?? new Set<string>();
  sessions.add(sessionId);
  unsettledCopies.set(location.locationId, sessions);
}

/**
 * Tries again to remove the copies {@link unsettledCopies} holds for this
 * location, forgetting each once it is removed. Never throws.
 */
async function removeUnsettledCopies(location: LocationProvider): Promise<void> {
  const sessions = unsettledCopies.get(location.locationId);
  if (!sessions) return;
  for (const sessionId of [...sessions]) {
    try {
      await deleteCopies(location, sessionId);
      sessions.delete(sessionId);
    } catch (error) {
      log.warn(
        'Could not remove the copy of a CLI conversation made for a session that did not start',
        {
          event: 'cli_conversation.copy_cleanup',
          stage: 'retry-failed',
          sessionId,
          error: String(error),
        }
      );
    }
  }
  if (sessions.size === 0 && unsettledCopies.get(location.locationId) === sessions)
    unsettledCopies.delete(location.locationId);
}

async function deleteCopies(location: LocationProvider, sessionId: string): Promise<void> {
  const request = await conversationRequest(location, { id: sessionId, title: 'Session' });
  const { deleted } = await runConversationRequest(
    location,
    '--delete-cli-conversation-copies',
    { ...request, consoleSessionId: sessionId },
    { deploy: false, timeout: DELETE_TIMEOUT_MS },
    deletedCliConversationCopiesSchema
  );
  if (deleted > 0)
    log.info('Removed the copy of a CLI conversation made for a session that did not start', {
      event: 'cli_conversation.copy_cleanup',
      stage: 'removed',
      sessionId,
      deleted,
    });
}

/**
 * What the host needs to look for conversations where the session's Claude
 * Code will: the variables, shell setup and inherited names its host starts
 * the provider with (`buildSharedHostConfig`).
 */
async function conversationRequest(
  location: LocationProvider,
  session: { id: string; title: string }
): Promise<CliConversationRequest> {
  const { sessionEnvVars, shellSetup } = await resolveSessionEnv(
    session,
    { path: location.dir, fs: location.fs },
    location.settings
  );
  return {
    provider: 'claude',
    dir: location.dir,
    env: sessionEnvVars,
    ...(shellSetup ? { shellSetup } : {}),
    inheritEnv: [...EXECUTION_INHERIT_ENV],
  };
}

/**
 * Runs one of the shared host's conversation commands where the location's
 * sessions run. A command that fails prints why on stdout; that reason is what
 * is thrown, as a {@link HostRefusedError}, rather than that the command
 * exited 1.
 */
async function runConversationRequest<T>(
  location: LocationProvider,
  mode: CliConversationMode,
  request: CliConversationRequest,
  options: { deploy: boolean; timeout: number },
  schema: z.ZodType<T>
): Promise<T> {
  let stdout: string;
  try {
    ({ stdout } = await runHostRequest(location.transport, mode, request, options));
  } catch (error) {
    const failure = cliConversationFailureSchema.safeParse(lastJsonLine(error));
    if (failure.success) throw new HostRefusedError(failure.data.error);
    throw error;
  }
  const answer = schema.safeParse(lastJsonLine({ stdout }));
  if (!answer.success)
    throw new Error(
      `Could not read what the agent's host answered: ${stdout.trim().slice(0, 200) || 'it printed nothing'}`
    );
  return answer.data;
}

function lastJsonLine(output: unknown): unknown {
  const stdout = (output as { stdout?: unknown } | null)?.stdout;
  if (typeof stdout !== 'string') return undefined;
  const line = stdout.trim().split('\n').at(-1);
  if (!line) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
