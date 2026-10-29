import {
  type CliConversationRequest,
  cliConversationFailureSchema,
  cliConversationListSchema,
  EXECUTION_INHERIT_ENV,
  forkedCliConversationSchema,
} from '@switch-console/agent-providers';
import { err, ok, type Result } from '@switch-console/shared';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { getAgentById } from '@main/core/agents/getAgentById';
import { locationManager } from '@main/core/locations/location-manager';
import type { LocationProvider } from '@main/core/locations/location-provider';
import { resolveSessionEnv } from '@main/core/locations/location-runtime-factory';
import { runHostRequest } from '@main/core/sdk-host/shared-host-deployment';
import { db } from '@main/db/client';
import { agents, sessions } from '@main/db/schema';
import type { CliConversationList } from '@shared/core/sessions/cli-conversations';

/** How long listing may take on the host, its shell setup included. */
const LIST_TIMEOUT_MS = 60_000;
/** How long copying may take on the host: a long conversation is a large file. */
const FORK_TIMEOUT_MS = 120_000;

/**
 * The conversations started in Claude Code's own CLI in an agent's folder that
 * a new session could continue, read on the machine the agent's sessions run
 * on. The copies Console's own sessions already run are left out.
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
    const [list, continued] = await Promise.all([
      runConversationRequest(
        location,
        '--cli-conversations',
        request,
        { deploy: false, timeout: LIST_TIMEOUT_MS },
        cliConversationListSchema
      ),
      continuedConversations(agent.locationId),
    ]);
    return ok({
      ...list,
      conversations: list.conversations.filter(
        (conversation) => !continued.has(conversation.nativeSessionId)
      ),
    });
  } catch (error) {
    return err({ message: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Copies a conversation started in Claude Code's CLI for `session` to continue,
 * and returns the copy's id. Refused while a Claude Code process has the
 * conversation open, or, where Claude Code cannot say, unless the person said
 * it is closed. Part of starting the session, so it deploys this build's
 * bundle to an SSH host that lacks it.
 */
export async function forkCliConversation(
  location: LocationProvider,
  session: { id: string; title: string },
  nativeSessionId: string,
  confirmedClosed: boolean
): Promise<string> {
  const request = await conversationRequest(location, session);
  const fork = await runConversationRequest(
    location,
    '--fork-cli-conversation',
    { ...request, nativeSessionId, confirmedClosed },
    { deploy: true, timeout: FORK_TIMEOUT_MS },
    forkedCliConversationSchema
  );
  return fork.nativeSessionId;
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
 * is thrown, rather than that the command exited 1.
 */
async function runConversationRequest<T>(
  location: LocationProvider,
  mode: '--cli-conversations' | '--fork-cli-conversation',
  request: CliConversationRequest,
  options: { deploy: boolean; timeout: number },
  schema: z.ZodType<T>
): Promise<T> {
  let stdout: string;
  try {
    ({ stdout } = await runHostRequest(location.transport, mode, request, options));
  } catch (error) {
    const failure = cliConversationFailureSchema.safeParse(lastJsonLine(error));
    if (failure.success) throw new Error(failure.data.error);
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

/** The native conversations Console's sessions in a location already run. */
async function continuedConversations(locationId: string): Promise<Set<string>> {
  const rows = await db
    .select({ config: sessions.config })
    .from(sessions)
    .innerJoin(agents, eq(sessions.agentId, agents.id))
    .where(eq(agents.locationId, locationId));
  return new Set(rows.flatMap((row) => row.config?.providerSessionId ?? []));
}
