import { remoteAttachmentPool } from '@main/core/agent-runtime/attachment/production-remote-attachment-pool';
import { isAttachableRuntime } from '@main/core/agent-runtime/attachment/types';
import { resolveSessionAgent } from '../../locations/utils';
import { loadSessionWithAgent } from '../session-join';
import { mapSessionRowToSession } from '../utils/utils';

/**
 * Bring a remote session fully to life *except* its terminal: the on-VM sidecar
 * and the shared hook-event relay, so it reports status, room membership and
 * notifications, and can be attached later without further setup.
 *
 * This is what a room-connected session needs at startup. The agent itself runs
 * in a tmux pane on the VM and the sidecar injects room messages there, so a
 * local PTY buys nothing until someone actually looks at the session.
 *
 * Deliberately does not write `agent_session_id`: that stays the marker for a
 * real first spawn, in `hydrateSession`.
 *
 * Returns false for a local session, which has no sidecar and must be hydrated
 * the usual way.
 */
export async function ensureSessionAttachable(sessionId: string): Promise<boolean> {
  const agent = resolveSessionAgent(sessionId);
  if (!agent) throw new Error('Session not found');
  if (!isAttachableRuntime(agent)) return false;

  const loaded = await loadSessionWithAgent(sessionId);
  if (!loaded) throw new Error('Session row not found');

  await agent.ensureAttachable(mapSessionRowToSession(loaded.row, loaded.providerId, loaded.name));
  remoteAttachmentPool.register(agent);
  return true;
}
