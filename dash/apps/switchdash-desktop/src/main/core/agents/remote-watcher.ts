import { DEEPLINK_SCHEME } from '@main/app/deeplinks';
import { ensureAgentSidecar } from '@main/core/agent-runtime/impl/ensure-agent-sidecar';
import { writeWatchEnabled } from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import { listAutoSessionAgentIds } from '@main/core/switch-rooms/auto-session-store';
import { log } from '@main/lib/logger';
import { getRemoteAgentLocation } from './agent-location';
import { connectRemoteAgent } from './connect-remote-agent';
import { getAgentById } from './getAgentById';
import { getAgents } from './getAgents';
import { reapStaleSidecarsForAgent } from './reap-stale-sidecars';
import { remoteSessionReconciler } from './remote-session-reconciler';

/**
 * Deploy + launch (or reattach to) the remote agent's sidecar so it auto-starts
 * sessions when addressed while switchdash is closed. The sidecar always runs
 * both jobs — hook server + injection AND the notification watcher — so this is
 * simply "ensure the agent's sidecar is up". No-op unless the agent is remote,
 * linked to a Switch server, and has auto_session enabled; a disabled agent gets
 * its sidecar stopped instead.
 *
 * The VM sidecar's watcher is the sole auto-session watcher for a remote agent;
 * switchdash's in-process `autoSessionWatcher` skips remote agents to avoid a
 * double-poll of the notification stream.
 */
/**
 * At switchdash startup, bring every remote auto_session agent's sidecar back up
 * (re-ensured after a VM reboot) and start reconciling the sessions its watcher
 * has been auto-starting while the UI was closed. Best-effort per agent — one
 * unreachable VM must not block the others. Mirrors the local
 * `autoSessionWatcher.initialize()`, which skips remote agents.
 */
export async function initializeRemoteWatchers(): Promise<void> {
  const ids = await listAutoSessionAgentIds();
  // The sidecar is scoped to (ssh host, repo dir): agents sharing one would drive
  // the same sidecar, the same launch-spec file, and the same tmux session. Ensure
  // one per unique host+dir so concurrent boot ensures don't race to launch the
  // same sidecar or write its spec. Extra same-dir agents are picked up on demand.
  const seen = new Set<string>();
  const remote: string[] = [];
  for (const agentId of ids) {
    const agent = await getAgentById(agentId);
    if (!agent) continue;
    const location = await getRemoteAgentLocation(agent);
    if (!location) continue;
    const key = location.id;
    if (seen.has(key)) {
      log.info('initializeRemoteWatchers: skipping agent sharing a sidecar dir at boot', {
        agentId,
        key,
      });
      continue;
    }
    seen.add(key);
    remote.push(agentId);
  }
  await Promise.all(
    remote.map((agentId) =>
      ensureRemoteWatcher(agentId).catch((error) => {
        log.warn('initializeRemoteWatchers: failed to ensure remote watcher', {
          agentId,
          error: String(error),
        });
      })
    )
  );
  log.info('initializeRemoteWatchers: initialised', { watching: remote.length });
}

/**
 * Start session discovery for every remote agent, independent of auto_session.
 * A second switchdash client must surface sessions another client (or the VM
 * watcher) started, and that discovery is the reconciler polling the sidecar's
 * `/sessions`. auto_session only governs whether the VM auto-STARTS sessions —
 * not whether this client can SEE them — so discovery must not be gated on it.
 * The reconciler only probes an already-running sidecar (never launches one), so
 * this stays cheap for idle agents. Idempotent; runs alongside
 * `initializeRemoteWatchers` (auto_session agents get both).
 */
export async function initializeRemoteDiscovery(): Promise<void> {
  const agents = await getAgents();
  for (const agent of agents) {
    if (!agent.switchAgentId) continue;
    if (await getRemoteAgentLocation(agent)) {
      remoteSessionReconciler.start(agent.id);
    }
  }
}

/** Start discovery for one remote agent (e.g. just added). Idempotent; no-op for non-remote. */
export async function startRemoteDiscovery(agentId: string): Promise<void> {
  const agent = await getAgentById(agentId);
  if (agent?.switchAgentId && (await getRemoteAgentLocation(agent))) {
    remoteSessionReconciler.start(agentId);
  }
}

export async function ensureRemoteWatcher(agentId: string): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error(`No agent with id ${agentId}`);
  if (!(await getRemoteAgentLocation(agent))) return;
  if (!agent.switchAgentId) {
    log.warn('ensureRemoteWatcher: agent has no Switch id; cannot watch', { agentId });
    return;
  }

  const enabled = (await listAutoSessionAgentIds()).includes(agentId);
  if (!enabled) {
    await stopRemoteWatcher(agentId);
    return;
  }

  const { ctx, connectionId, remoteRepoDir, host } = await connectRemoteAgent(agent);
  await ensureAgentSidecar({
    providerId: agent.providerId,
    repoDir: remoteRepoDir,
    deeplinkScheme: DEEPLINK_SCHEME,
    autoApprove: agent.autoApprove,
    credsSlug: agent.name ?? agent.id,
    agentName: agent.name ?? null,
    ctx,
    connectionId,
    host,
  });
  await writeWatchEnabled(host, agent.name ?? agent.id, true);
  await reapStaleSidecarsForAgent(agent, host, remoteRepoDir);
  log.info('ensureRemoteWatcher: sidecar deployed + watching', {
    agentId,
    switchAgentId: agent.switchAgentId,
  });

  // Surface the sessions the VM watcher auto-starts (and any already running)
  // in the switchdash UI. Idempotent; polls periodically while enabled.
  remoteSessionReconciler.start(agentId);
}

/**
 * Disable auto-start for a remote agent (auto_session toggled off). Flips the
 * sidecar's live watch flag off rather than killing it, so any UI-started
 * session on the VM keeps getting messages injected — the sidecar just stops
 * auto-starting new sessions.
 */
export async function stopRemoteWatcher(agentId: string): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent || !(await getRemoteAgentLocation(agent))) return;
  remoteSessionReconciler.stop(agentId);
  const { host } = await connectRemoteAgent(agent);
  await writeWatchEnabled(host, agent.name ?? agent.id, false);
  log.info('stopRemoteWatcher: watching disabled', { agentId });
}
