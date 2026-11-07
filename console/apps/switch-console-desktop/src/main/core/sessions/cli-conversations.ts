import {
  type CliConversationMode,
  type CliConversationRequest,
  cliConversationFailureSchema,
  cliConversationListSchema,
  deletedCliConversationCopiesSchema,
  EXECUTION_INHERIT_ENV,
  forkedCliConversationSchema,
  MAX_SESSIONS_PER_REQUEST,
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
/** How long removing sessions' copies may take on the host. */
const DELETE_TIMEOUT_MS = 60_000;
/**
 * How long after a copy's outcome became unknown a removal that finds no copy
 * is taken at its word. Until then the copy may still be being made: a copy
 * Console stopped waiting for can finish on the host well after that.
 */
const UNSETTLED_COPY_WINDOW_MS = 15 * 60_000;

/**
 * What a request that is not one session's resolves the session's environment
 * with: it only says where the session's Claude Code would look.
 */
const NO_SESSION = { id: 'new-session', title: 'Session' };

/** The host ran the command and said why it failed, so its outcome is known. */
export class HostRefusedError extends Error {}

/**
 * Sessions whose copy may still be on a location's host, by location id, each
 * with when that was last found to be so: the copy was asked for and no
 * answer came back (a timeout, a dropped connection), so it may be made after
 * Console stopped waiting; or its session will not run, and the copy has yet
 * to be removed. Each list or copy in the location tries removing them again,
 * in the background. A session is forgotten once a removal finds its copy, or
 * once one finds none {@link UNSETTLED_COPY_WINDOW_MS} after it was recorded; a
 * removal that fails says nothing, and is tried again. In memory only, so a
 * copy whose session is forgotten across a restart stays; it is still tagged
 * as a copy and hidden from the dialog.
 */
const unsettledCopies = new Map<string, Map<string, number>>();

/** The removal running in each location, by location id, which the next one there follows. */
const removals = new Map<string, Promise<void>>();

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
    const request = await conversationRequest(location, NO_SESSION);
    void removeUnsettledCopies(location);
    return ok(
      await runConversationRequest(
        location,
        '--cli-conversations',
        request,
        { deploy: false, timeout: LIST_TIMEOUT_MS },
        cliConversationListSchema
      )
    );
  } catch (error) {
    return err({ message: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Copies a conversation started in Claude Code's CLI for `session` to continue,
 * and returns the copy's id. The copy is tagged with the session, so a copy
 * whose session never starts can be removed ({@link discardCliConversationCopies}).
 * Refused while a Claude Code process has the conversation open, or, where
 * Claude Code cannot say, unless the person said it is closed. A copy the host
 * refused, a {@link HostRefusedError}, leaves none tagged as the session's.
 * Part of starting the session, so it deploys this build's bundle to an SSH
 * host that lacks it.
 */
export async function forkCliConversation(
  location: LocationProvider,
  session: { id: string; title: string },
  nativeSessionId: string,
  confirmedClosed: boolean
): Promise<string> {
  const request = await conversationRequest(location, session);
  void removeUnsettledCopies(location);
  const fork = await runConversationRequest(
    location,
    '--fork-cli-conversation',
    { ...request, nativeSessionId, consoleSessionId: session.id, confirmedClosed },
    { deploy: true, timeout: FORK_TIMEOUT_MS },
    forkedCliConversationSchema
  ).catch((error: unknown) => {
    if (!(error instanceof HostRefusedError)) rememberUnsettledCopy(location, session.id);
    throw error;
  });
  return fork.nativeSessionId;
}

/**
 * Removes the copies made for a session that will not run: its copy's
 * outcome is unknown, or it finished after the session's row was deleted.
 * Only conversations tagged as this session's are removed, and the session is
 * tried again with the location's next list or copy until its copy is found
 * or long enough has passed ({@link unsettledCopies}). Nothing needs to wait
 * for it: the returned promise settles once this attempt is over and never
 * rejects, so it cannot hide why the session did not start.
 */
export function discardCliConversationCopies(
  location: LocationProvider,
  sessionId: string
): Promise<void> {
  rememberUnsettledCopy(location, sessionId);
  return removeUnsettledCopies(location);
}

function rememberUnsettledCopy(location: LocationProvider, sessionId: string): void {
  const sessions = unsettledCopies.get(location.locationId) ?? new Map<string, number>();
  sessions.set(sessionId, Date.now());
  unsettledCopies.set(location.locationId, sessions);
}

/**
 * Tries again to remove the copies {@link unsettledCopies} holds for this
 * location, once the removal already running there is over, and settles when
 * it is. Never rejects.
 */
function removeUnsettledCopies(location: LocationProvider): Promise<void> {
  const next = (removals.get(location.locationId) ?? Promise.resolve()).then(() =>
    removeCopiesOnce(location)
  );
  removals.set(location.locationId, next);
  void next.then(() => {
    if (removals.get(location.locationId) === next) removals.delete(location.locationId);
  });
  return next;
}

/**
 * One attempt at {@link removeUnsettledCopies}, with one request to the host
 * for each {@link MAX_SESSIONS_PER_REQUEST} sessions, each made whether or not
 * the one before it failed. Never throws.
 */
async function removeCopiesOnce(location: LocationProvider): Promise<void> {
  const sessions = unsettledCopies.get(location.locationId);
  if (!sessions?.size) return;
  const sessionIds = [...sessions.keys()];
  for (let start = 0; start < sessionIds.length; start += MAX_SESSIONS_PER_REQUEST)
    await removeSomeCopies(
      location,
      sessions,
      sessionIds.slice(start, start + MAX_SESSIONS_PER_REQUEST)
    );
  if (sessions.size === 0 && unsettledCopies.get(location.locationId) === sessions)
    unsettledCopies.delete(location.locationId);
}

/**
 * One request of {@link removeCopiesOnce}: removes these sessions' copies and
 * forgets each session whose copy was found, or was looked for long enough. A
 * request that fails forgets none of them. Never throws.
 */
async function removeSomeCopies(
  location: LocationProvider,
  sessions: Map<string, number>,
  sessionIds: string[]
): Promise<void> {
  let deleted: Record<string, number>;
  try {
    deleted = await deleteCopies(location, sessionIds);
  } catch (error) {
    log.warn(
      'Could not remove the copies of CLI conversations made for sessions that did not start',
      {
        event: 'cli_conversation.copy_cleanup',
        stage: 'failed',
        sessionIds,
        error: String(error),
      }
    );
    return;
  }
  const now = Date.now();
  for (const sessionId of sessionIds) {
    const recordedAt = sessions.get(sessionId);
    if (recordedAt === undefined) continue;
    const count = deleted[sessionId] ?? 0;
    if (count > 0) {
      sessions.delete(sessionId);
      log.info('Removed the copy of a CLI conversation made for a session that did not start', {
        event: 'cli_conversation.copy_cleanup',
        stage: 'removed',
        sessionId,
        deleted: count,
      });
    } else if (now - recordedAt >= UNSETTLED_COPY_WINDOW_MS) {
      sessions.delete(sessionId);
      log.warn(
        'Stopped looking for the copy of a CLI conversation made for a session that did not start: none was found long after it was asked for',
        {
          event: 'cli_conversation.copy_cleanup',
          stage: 'abandoned',
          sessionId,
          recordedAt: new Date(recordedAt).toISOString(),
        }
      );
    }
  }
}

/**
 * Removes the copies tagged as these sessions', at most
 * {@link MAX_SESSIONS_PER_REQUEST} of them, in one request, and says how many
 * each had.
 */
async function deleteCopies(
  location: LocationProvider,
  sessionIds: string[]
): Promise<Record<string, number>> {
  const request = await conversationRequest(location, NO_SESSION);
  const { deleted } = await runConversationRequest(
    location,
    '--delete-cli-conversation-copies',
    { ...request, consoleSessionIds: sessionIds },
    { deploy: false, timeout: DELETE_TIMEOUT_MS },
    deletedCliConversationCopiesSchema
  );
  return deleted;
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
