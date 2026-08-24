import { eq } from 'drizzle-orm';
import { DEEPLINK_SCHEME } from '@main/app/deeplinks';
import { probeAgentSidecar } from '@main/core/agent-runtime/impl/ensure-agent-sidecar';
import {
  type SidecarEndpoint,
  type SidecarHost,
  writeWatchEnabled,
} from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import { httpGetJsonOverChannel } from '@main/core/agent-runtime/impl/sidecar-http';
import { sessionHooks } from '@main/core/sessions/session-hooks';
import { sessionRuntimeManager } from '@main/core/sessions/session-runtime-manager';
import { switchRoomService } from '@main/core/switch-rooms/switch-room-service';
import { agentTypeOf } from '@main/core/telemetry/agent-type';
import type { TelemetryAgentResetFailure } from '@main/core/telemetry/events';
import { trackEvent } from '@main/core/telemetry/telemetry-service';
import { viewStateService } from '@main/core/view-state/view-state-service';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import { sessionDeletedChannel } from '@shared/core/sessions/sessionEvents';
import { agentLaunchSpecialization } from './agent-launch-config';
import { getRemoteAgentLocation } from './agent-location';
import { connectRemoteAgent } from './connect-remote-agent';
import { getAgentById } from './getAgentById';
import { remoteSessionReconciler } from './remote-session-reconciler';
import { ensureRemoteWatcher, startRemoteDiscovery } from './remote-watcher';
import { buildKillTmuxScript, resetTmuxTargets } from './reset-remote-agent-tmux';

const SESSIONS_REQUEST_TIMEOUT_MS = 10_000;

/**
 * A reset that failed for a reason worth naming.
 *
 * The reason travels as a field rather than in the message, so it can be
 * reported as a code without anyone matching on prose. Everything left unnamed —
 * an exec, the transport dropping mid-reset — is reported as `error`, because a
 * remote failure's own text is not ours to enumerate and never ours to send.
 */
class AgentResetError extends Error {
  constructor(
    readonly reason: TelemetryAgentResetFailure,
    message: string
  ) {
    super(message);
  }
}

/**
 * Reasons for failures this module did not raise itself.
 *
 * The one worth naming most comes from below: reaching the host fails with the
 * transport's own error, and the interface branches on that error's class to
 * tell someone their host is unreachable rather than that "something went
 * wrong". Wrapping it in one of ours would buy a code and lose that, so the
 * reason is remembered beside the error and the error travels untouched.
 */
const namedFailures = new WeakMap<object, TelemetryAgentResetFailure>();

/** Remember why an error happened, and hand it straight back. */
function named<E>(error: E, reason: TelemetryAgentResetFailure): E {
  if (typeof error === 'object' && error !== null) namedFailures.set(error, reason);
  return error;
}

function resetFailureReason(error: unknown): TelemetryAgentResetFailure {
  if (error instanceof AgentResetError) return error.reason;
  if (typeof error === 'object' && error !== null) return namedFailures.get(error) ?? 'error';
  return 'error';
}

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
      credsSlug: agent.name ?? agent.id,
      agentName: agent.name ?? null,
      specialization: await agentLaunchSpecialization(agent.id),
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
  // The same pair the reconciler's remote-driven delete fires: the hook for
  // anything in the main process that tracks a session's lifetime, and the IPC
  // event so an open window drops the row. Firing only the second leaves a
  // session that was reported as started and never as ended.
  sessionHooks._emit('session:deleted', sessionId);
  events.emit(sessionDeletedChannel, { sessionId });
}

/**
 * Reset a remote agent: kill every one of its tmux sessions on the remote host —
 * the sidecar/watcher session and every agent (Claude Code) session — then bring
 * the agent back up fresh so it can start clean (CHOO-1656).
 *
 * The kill scope is the union of the sessions Switch Console has rows for and the
 * sessions the VM sidecar reports live, so it covers sessions this client never
 * opened while staying scoped to THIS agent's sidecar (host + repo dir) rather
 * than sweeping every Switch Console session on a shared host.
 *
 * Fails loud: a real remote teardown error (a `kill-session` that fails, a
 * broken SSH transport) propagates instead of being swallowed. Remote-only —
 * throws for a local agent.
 */
export async function resetRemoteAgent(agentId: string): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent) {
    trackEvent('agent_reset', {
      agent_type: 'unknown',
      outcome: 'failure',
      failure_reason: 'agent_not_found',
    });
    throw new AgentResetError('agent_not_found', `No agent with id ${agentId}`);
  }

  const agentType = agentTypeOf(agent.providerId);
  try {
    await runReset(agentId, agent);
  } catch (error) {
    trackEvent('agent_reset', {
      agent_type: agentType,
      outcome: 'failure',
      failure_reason: resetFailureReason(error),
    });
    throw error;
  }
  trackEvent('agent_reset', { agent_type: agentType, outcome: 'success', failure_reason: 'none' });
}

async function runReset(agentId: string, agent: Agent): Promise<void> {
  const location = await getRemoteAgentLocation(agent);
  if (!location) {
    throw new AgentResetError(
      'not_remote',
      `Agent ${agentId} is not remote, so it cannot be reset.`
    );
  }

  // Stop this client's discovery loop before killing anything so a reconcile tick
  // cannot re-adopt a session from a stale snapshot mid-reset.
  remoteSessionReconciler.stop(agentId);

  let conn: RemoteConn;
  try {
    conn = await connectRemoteAgent(agent);
  } catch (error) {
    // The likeliest way a reset fails, and the only step here that depends on
    // something outside the app — worth separating from everything the app
    // itself can get wrong.
    throw named(error, 'connect');
  }
  const credsSlug = agent.name ?? agent.id;

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

  // Bring the agent back up fresh, the same way Switch Console does at boot: re-ensure
  // the sidecar + watcher (when auto_session is on) and restart session discovery.
  await ensureRemoteWatcher(agentId);
  await startRemoteDiscovery(agentId);
  log.info('resetRemoteAgent: reset complete', { agentId });
}
