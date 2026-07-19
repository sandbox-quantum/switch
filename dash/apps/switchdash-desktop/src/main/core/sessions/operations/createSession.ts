import { err, ok, type Result } from '@switchdash/shared';
import { eq, sql } from 'drizzle-orm';
import { getAgentById } from '@main/core/agents/getAgentById';
import { projectManager } from '@main/core/projects/project-manager';
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

/**
 * Eager create (decision A): inserts the session row and immediately provisions
 * the runtime in the project root, then spawns the agent. There is no separate
 * workspace to provision — every session runs in the project directory resolved
 * via session → agent → project.
 */
export async function createSession(
  params: CreateSessionParams
): Promise<Result<CreateSessionSuccess, CreateSessionError>> {
  const agent = await getAgentById(params.agentId);
  if (!agent) return err({ type: 'agent-not-found' });

  const project = projectManager.getProject(agent.projectId);
  if (!project) return err({ type: 'agent-not-found' });

  const configObj: SessionConfig = {};
  if (params.autoApprove !== undefined) configObj.autoApprove = params.autoApprove;
  if (params.initialPrompt?.trim()) configObj.initialPrompt = params.initialPrompt.trim();
  if (params.subagentName?.trim()) configObj.subagentName = params.subagentName.trim();
  const config = Object.keys(configObj).length > 0 ? configObj : undefined;

  const [row] = await db
    .insert(sessions)
    .values({
      id: params.id,
      agentId: params.agentId,
      title: params.title,
      shellId: params.shellId ?? 'system',
      config,
      agentSessionId: params.id,
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

  const session = mapSessionRowToSession(row, agent.providerId);

  try {
    const built = await provisionSessionRuntime(session, project);
    await sessionRuntimeManager.registerSession(session.id, built, project.projectId, project.ctx);

    await built.agent.start(session, params.initialSize, false, params.initialPrompt);
  } catch (e) {
    await db.delete(sessions).where(eq(sessions.id, params.id));
    return err({ type: 'spawn-failed', message: e instanceof Error ? e.message : String(e) });
  }

  return ok({ session });
}
