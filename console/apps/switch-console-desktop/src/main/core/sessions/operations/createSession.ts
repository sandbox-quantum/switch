import { err, ok, type Result } from '@switch-console/shared';
import { eq, sql } from 'drizzle-orm';
import { providerAdapterRegistry } from '@main/core/agent-runtime/impl/provider-adapter-registry';
import { getAgentById } from '@main/core/agents/getAgentById';
import { locationManager } from '@main/core/locations/location-manager';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import type { SessionConfig } from '@shared/core/sessions/session-config';
import type {
  CreateSessionError,
  CreateSessionSuccess,
  CreateSessionParams,
} from '@shared/core/sessions/sessions';
import { provisionSessionRuntime } from '../session-builder';
import { sessionRuntimeManager } from '../session-runtime-manager';
import { mapSessionRowToSession } from '../utils/utils';

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
      message: 'SDK sessions support Claude Code, Codex, OpenCode, Gemini CLI and Cursor.',
    });
  if (!adopted && process.platform === 'win32' && location?.transport.kind !== 'ssh')
    return err({
      type: 'spawn-failed',
      message: 'SDK sessions require a POSIX execution host. Select an SSH host.',
    });

  const configObj: SessionConfig = {};
  if (params.autoApprove !== undefined) configObj.autoApprove = params.autoApprove;
  if (params.initialPrompt?.trim()) configObj.initialPrompt = params.initialPrompt.trim();
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
      shellId: params.shellId ?? 'system',
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

  const session = mapSessionRowToSession(row, agent.providerId, agent.name);

  if (adopted) return ok({ session });
  if (!location) return err({ type: 'agent-not-found' });
  try {
    const built = await provisionSessionRuntime(session, location);
    await sessionRuntimeManager.registerSession(session.id, built, location.ctx);

    await built.agent.start(
      session,
      params.initialSize,
      params.attach === false,
      params.initialPrompt
    );
  } catch (e) {
    await db.update(sessions).set({ status: 'review' }).where(eq(sessions.id, session.id));
    return err({ type: 'spawn-failed', message: e instanceof Error ? e.message : String(e) });
  }

  return ok({ session });
}
