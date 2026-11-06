import type { HostStartSource } from '@switch-console/agent-providers';
import { err, ok, type Result } from '@switch-console/shared';
import { eq, sql } from 'drizzle-orm';
import { providerAdapterRegistry } from '@main/core/agent-runtime/impl/provider-adapter-registry';
import { getAgentById } from '@main/core/agents/getAgentById';
import { locationManager } from '@main/core/locations/location-manager';
import { ensureWatcherCanContinueCliConversation } from '@main/core/sdk-host/watcher-bundle-check';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { providerNamesSentence } from '@shared/core/providers/agent-provider-registry';
import type { SessionConfig } from '@shared/core/sessions/session-config';
import type {
  CreateSessionError,
  CreateSessionSuccess,
  CreateSessionParams,
} from '@shared/core/sessions/sessions';
import type { SessionStartSource } from '@shared/core/telemetry/reporting';
import { trackCliConversationFork } from '../cli-conversation-forks';
import {
  discardCliConversationCopies,
  forkCliConversation,
  HostRefusedError,
} from '../cli-conversations';
import { provisionSessionRuntime } from '../session-builder';
import { sessionRuntimeManager } from '../session-runtime-manager';
import { mapSessionRowToSession } from '../utils/utils';
import { setProviderSessionId } from './set-provider-session-id';

/**
 * What the session's host tells Switch about how it started. `adopted` never
 * gets here with a launch, and a caller that said nothing is reported as
 * `unknown` by the host rather than guessed at.
 */
function hostStartSource(source: SessionStartSource | undefined): HostStartSource | null {
  if (source === 'user') return 'user';
  if (source === 'auto') return 'automation';
  return null;
}

export async function createSession(
  params: CreateSessionParams
): Promise<Result<CreateSessionSuccess, CreateSessionError>> {
  const agent = await getAgentById(params.agentId);
  if (!agent) return err({ type: 'agent-not-found' });

  const adopted = params.startSource === 'adopted';
  const location = adopted ? null : locationManager.getLocation(agent.locationId);
  if (!adopted && !location) return err({ type: 'agent-not-found' });

  if (!providerAdapterRegistry.supports(agent.providerId))
    return err({
      type: 'spawn-failed',
      message: `SDK sessions support ${providerNamesSentence()}.`,
    });
  if (!adopted && process.platform === 'win32' && location?.transport.kind !== 'ssh')
    return err({
      type: 'spawn-failed',
      message: 'SDK sessions require a POSIX execution host. Select an SSH host.',
    });

  const configObj: SessionConfig = {};
  if (params.initialPrompt?.trim()) configObj.initialPrompt = params.initialPrompt.trim();
  if (params.cliConversation) {
    if (!location) return err({ type: 'agent-not-found' });
    if (agent.providerId !== 'claude')
      return err({
        type: 'spawn-failed',
        message: 'Only Claude Code agents can continue a conversation started in its CLI.',
      });
    // Asked before anything is recorded or copied, so a session its Room
    // watcher could not start is never left holding a copy.
    if (location.transport.kind === 'ssh' && agent.switchAgentId)
      try {
        await ensureWatcherCanContinueCliConversation(
          location.ctx,
          location.transport.host,
          agent.switchAgentId
        );
      } catch (e) {
        return err({ type: 'spawn-failed', message: e instanceof Error ? e.message : String(e) });
      }
    configObj.cliConversation = {
      nativeSessionId: params.cliConversation.nativeSessionId,
      title: params.cliConversation.title,
    };
  }
  // The session's launch identity is not stored — it is read live from the
  // owning agent's `name` (see mapSessionRowToSession). How that name spawns is
  // the provider's business (Claude Code → `--agent <name>`) (CHOO-1440).
  const config = Object.keys(configObj).length > 0 ? configObj : undefined;

  const [row] = await db
    .insert(sessions)
    .values({
      id: params.id,
      agentId: params.agentId,
      title: params.title,
      config,
      isInitialSession: false,
      status: 'in_progress',
      updatedAt: sql`CURRENT_TIMESTAMP`,
      statusChangedAt: sql`CURRENT_TIMESTAMP`,
      lastInteractedAt: sql`CURRENT_TIMESTAMP`,
    })
    .onConflictDoNothing()
    .returning();

  // Callers with externally-minted ids (the remote session reconciler adopting
  // a VM session) can race another creator for the same id — surface that
  // as a Result instead of a raw UNIQUE-constraint throw.
  if (!row) return err({ type: 'already-exists' });

  let session = mapSessionRowToSession(row, agent.providerId, agent.name);

  if (adopted) return ok({ session });
  if (!location) return err({ type: 'agent-not-found' });
  if (params.cliConversation) {
    // Copied once the session's row holds its id, tagged with it, so a copy
    // always names a session to own it. One that cannot be made (open in a
    // terminal, say) takes the row away again, and whatever copy was made is
    // removed; one the host refused left none. The copy is what the session
    // resumes; the CLI's own conversation is never written to. Anything that
    // starts the session while the copy is made waits for it
    // (`trackCliConversationFork`).
    const { nativeSessionId, confirmedClosed } = params.cliConversation;
    const owner = { id: session.id, title: session.title };
    try {
      const providerSessionId = await trackCliConversationFork(
        session.id,
        (async () => {
          const copy = await forkCliConversation(location, owner, nativeSessionId, confirmedClosed);
          // Into the row as it stands after the copy, which can take a while.
          if (!(await setProviderSessionId(owner.id, copy)))
            throw new Error('This session was deleted while its conversation was being copied.');
          return copy;
        })()
      );
      session = { ...session, providerSessionId };
    } catch (e) {
      // Not waited for: it never throws, and the reason the session did not
      // start is what the person is waiting to hear.
      if (!(e instanceof HostRefusedError)) void discardCliConversationCopies(location, session.id);
      try {
        await db.delete(sessions).where(eq(sessions.id, session.id));
      } catch (removal) {
        // The reason the copy failed is still the one to give. The row left
        // behind refuses to start, saying its copy was never made.
        log.error('Could not remove a session whose CLI conversation was not copied', {
          event: 'cli_conversation.session_rollback',
          stage: 'delete-failed',
          sessionId: session.id,
          error: String(removal),
        });
      }
      return err({ type: 'spawn-failed', message: e instanceof Error ? e.message : String(e) });
    }
  }
  try {
    const built = await provisionSessionRuntime(session, location);
    await sessionRuntimeManager.registerSession(session.id, built, location.ctx);

    await built.agent.start(
      session,
      params.attach === false,
      params.initialPrompt,
      hostStartSource(params.startSource)
    );
  } catch (e) {
    await db.update(sessions).set({ status: 'review' }).where(eq(sessions.id, session.id));
    return err({ type: 'spawn-failed', message: e instanceof Error ? e.message : String(e) });
  }

  return ok({ session });
}
