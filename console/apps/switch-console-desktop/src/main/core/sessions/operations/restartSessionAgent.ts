import { resolveSessionAgent } from '../../locations/utils';
import { loadSessionWithAgent } from '../session-join';
import { mapSessionRowToSession } from '../utils/utils';

/**
 * Stop a session's agent process and start it again in place.
 *
 * This is how a per-agent setting that is only read at spawn — the Codex launch
 * profile's model, reasoning effort and instructions — reaches a session that is
 * already running. Nothing else re-reads it: the CLI parses its profile once, at
 * startup.
 *
 * The restart resumes rather than starting a fresh conversation, so the session
 * keeps its history and picks up the new profile; `codex resume` is specialized
 * by the same profile as a first launch. The session row is untouched — the
 * session stays provisioned throughout and only its agent process is replaced.
 */
export async function restartSessionAgent(sessionId: string): Promise<void> {
  const agent = resolveSessionAgent(sessionId);
  if (!agent) throw new Error(`Session ${sessionId} has no running agent to restart`);

  const loaded = await loadSessionWithAgent(sessionId);
  if (!loaded) throw new Error(`Session row not found for ${sessionId}`);

  const session = mapSessionRowToSession(loaded.row, loaded.providerId, loaded.name);

  await agent.stop();
  await agent.start(session, undefined, true);
}
