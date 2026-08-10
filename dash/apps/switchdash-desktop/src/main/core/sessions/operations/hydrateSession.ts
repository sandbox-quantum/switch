import { eq } from 'drizzle-orm';
import { remoteAttachmentPool } from '@main/core/agent-runtime/attachment/production-remote-attachment-pool';
import { isAttachableRuntime } from '@main/core/agent-runtime/attachment/types';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { resolveSessionAgent } from '../../locations/utils';
import { loadSessionWithAgent } from '../session-join';
import { mapSessionRowToSession } from '../utils/utils';

/**
 * Open a session's terminal.
 *
 * A first spawn has no remote pane yet and carries the session's initial
 * prompt, so it goes straight to the runtime. Every later hydrate is a view
 * onto a pane that is already running, and goes through the attachment pool —
 * which bounds how many terminals a single host holds open and serialises the
 * channel opens so a slow tunnel is not stampeded.
 */
export async function hydrateSession(sessionId: string): Promise<void> {
  const agent = resolveSessionAgent(sessionId);
  if (!agent) throw new Error('Session not found');

  const loaded = await loadSessionWithAgent(sessionId);
  if (!loaded) throw new Error('Session row not found');
  const row = loaded.row;

  const isFirstSpawn = row.agentSessionId === null;

  if (isFirstSpawn) {
    // Write agent_session_id before spawning — idempotency guard against double-hydrate.
    await db.update(sessions).set({ agentSessionId: sessionId }).where(eq(sessions.id, sessionId));
  }

  const config = row.config ?? {};
  const session = mapSessionRowToSession(row, loaded.providerId, loaded.name);

  if (!isFirstSpawn && isAttachableRuntime(agent)) {
    await agent.ensureAttachable(session);
    remoteAttachmentPool.register(agent);
    await remoteAttachmentPool.requestAttach(sessionId, 'user');
    return;
  }

  await agent.start(
    session,
    undefined,
    !isFirstSpawn,
    isFirstSpawn ? config.initialPrompt : undefined
  );
}
