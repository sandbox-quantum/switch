import { eq } from 'drizzle-orm';
import { DEEPLINK_SCHEME } from '@main/app/deeplinks';
import { probeAgentSidecar } from '@main/core/agent-runtime/impl/ensure-agent-sidecar';
import {
  type SidecarEndpoint,
  type SidecarHost,
  writeWatchEnabled,
} from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import { httpGetJsonOverChannel } from '@main/core/agent-runtime/impl/sidecar-http';
import { sessionRuntimeManager } from '@main/core/sessions/session-runtime-manager';
import { switchRoomService } from '@main/core/switch-rooms/switch-room-service';
import { viewStateService } from '@main/core/view-state/view-state-service';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import { sessionDeletedChannel } from '@shared/core/sessions/sessionEvents';
import { getRemoteAgentLocation } from './agent-location';
import { connectRemoteAgent } from './connect-remote-agent';
import { getAgentById } from './getAgentById';
import { remoteSessionReconciler } from './remote-session-reconciler';
import { ensureRemoteWatcher, startRemoteDiscovery } from './remote-watcher';
import { buildKillTmuxScript, resetTmuxTargets } from './reset-remote-agent-tmux';

const SESSIONS_REQUEST_TIMEOUT_MS = 10_000;

interface SidecarSessionsResponse {
  sessions: Array<{ sessionId: string; roomId: string | null }>;
}

type RemoteConn = Awaited<ReturnType<typeof connectRemoteAgent>>;

/**
 * The live session ids the on-VM sidecar is running, or an empty list. Best
 * effort: the sidecar is about to be killed anyway, so a dead/unreachable
 * sidecar contributes nothing rather than aborting the reset — the DB rows still
 * cover the sessions this client knows about. Real teardown errors surface later,
 * when the tmux sessions are actually killed.
 */
async function fetchSidecarSessionIds(agent: Agent, conn: RemoteConn): Promise<string[]> {
  let endpoint: SidecarEndpoint | null;
  try {
    endpoint = await probeAgentSidecar({
      providerId: agent.providerId,
      repoDir: conn.remoteRepoDir,
      deeplinkScheme: DEEPLINK_SCHEME,
      autoApprove: agent.autoApprove,
      credsSlug: agent.definitionName ?? agent.id,
      definitionName: agent.definitionName ?? null,
      ctx: conn.ctx,
      connectionId: conn.connectionId,
      host: conn.host,
    });
  } catch (error) {
    log.warn('resetRemoteAgent: failed to probe sidecar for sessions', {
      agentId: agent.id,
      error: String(error),
    });
    return [];
  }
  if (!endpoint) return [];

  const channel = await conn.proxy.forwardOut(endpoint.port);
  try {
    const response = await httpGetJsonOverChannel<SidecarSessionsResponse>(channel, {
      port: endpoint.port,
      token: endpoint.token,
      path: '/sessions',
      timeoutMs: SESSIONS_REQUEST_TIMEOUT_MS,
    });
    return (response.sessions ?? []).map((s) => s.sessionId);
  } catch (error) {
    log.warn('resetRemoteAgent: failed to read sidecar /sessions', {
      agentId: agent.id,
      error: String(error),
    });
    return [];
  } finally {
    channel.destroy();
  }
}

/**
 * Kill the given tmux sessions on the remote host, failing loud: a real
 * `kill-session` failure or a broken SSH transport rejects the exec rather than
 * being swallowed. This is the "fail loud on remote teardown errors" the reset
 * must guarantee.
 */
async function killTmuxSessions(host: SidecarHost, sessionNames: string[]): Promise<void> {
  const script = buildKillTmuxScript(sessionNames);
  if (!script) return;
  await host.exec('sh', ['-c', script]);
}

/**
 * Drop a session's local footprint after its remote tmux pane is gone: tear down
 * its runtime, delete its row, clear its view-state + room badge, and tell the
 * renderer to remove it. Mirrors the remote-driven delete in
 * {@link remoteSessionReconciler}, so a wiped session does not linger as a ghost
 * row in any open window.
 */
async function removeLocalSession(sessionId: string): Promise<void> {
  await sessionRuntimeManager.teardownSession(sessionId).catch((error) => {
    log.warn('resetRemoteAgent: failed to teardown session runtime', {
      sessionId,
      error: String(error),
    });
  });
  switchRoomService.clearSession(sessionId);
  const deleted = await db.delete(sessions).where(eq(sessions.id, sessionId));
  await viewStateService.del(`session:${sessionId}`);
  if (deleted.changes === 0) return;
  events.emit(sessionDeletedChannel, { sessionId });
}

/**
 * Reset a remote agent: kill every one of its tmux sessions on the remote host —
 * the sidecar/watcher session and every agent (Claude Code) session — then bring
 * the agent back up fresh so it can start clean (CHOO-1656).
 *
 * The kill scope is the union of the sessions switchdash has rows for and the
 * sessions the VM sidecar reports live, so it covers sessions this client never
 * opened while staying scoped to THIS agent's sidecar (host + repo dir) rather
 * than sweeping every switchdash session on a shared host.
 *
 * Fails loud: a real remote teardown error (a `kill-session` that fails, a
 * broken SSH transport) propagates instead of being swallowed. Remote-only —
 * throws for a local agent.
 */
export async function resetRemoteAgent(agentId: string): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error(`No agent with id ${agentId}`);
  const location = await getRemoteAgentLocation(agent);
  if (!location) {
    throw new Error(`Agent ${agentId} is not remote, so it cannot be reset.`);
  }

  // Stop this client's discovery loop before killing anything so a reconcile tick
  // cannot re-adopt a session from a stale snapshot mid-reset.
  remoteSessionReconciler.stop(agentId);

  const conn = await connectRemoteAgent(agent);
  const credsSlug = agent.definitionName ?? agent.id;

  // Silence the VM watcher first so it cannot auto-start a fresh session between
  // the /sessions snapshot and the kill (whose pane we would then miss).
  await writeWatchEnabled(conn.host, credsSlug, false);

  const dbSessionIds = (
    await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.agentId, agentId))
  ).map((r) => r.id);
  const sidecarSessionIds = await fetchSidecarSessionIds(agent, conn);
  const sessionIds = [...new Set([...dbSessionIds, ...sidecarSessionIds])];

  await killTmuxSessions(conn.host, resetTmuxTargets(sessionIds, conn.remoteRepoDir, credsSlug));
  log.info('resetRemoteAgent: killed remote tmux sessions', {
    agentId,
    sessions: sessionIds.length,
  });

  await Promise.all(dbSessionIds.map((id) => removeLocalSession(id)));

  // Bring the agent back up fresh, the same way switchdash does at boot: re-ensure
  // the sidecar + watcher (when auto_session is on) and restart session discovery.
  await ensureRemoteWatcher(agentId);
  await startRemoteDiscovery(agentId);
  log.info('resetRemoteAgent: reset complete', { agentId });
}
