import { eq, inArray } from 'drizzle-orm';
import { DEEPLINK_SCHEME } from '@main/app/deeplinks';
import { probeAgentSidecar } from '@main/core/agent-runtime/impl/ensure-agent-sidecar';
import type { SidecarEndpoint } from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import { httpGetJsonOverChannel } from '@main/core/agent-runtime/impl/sidecar-http';
import { sessionHooks } from '@main/core/sessions/session-hooks';
import { sessionService } from '@main/core/sessions/session-service';
import { sshConnectionManager } from '@main/core/ssh/lifecycle/production-ssh-connection-manager';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import { sessionDeletedChannel } from '@shared/core/sessions/sessionEvents';
import { connectRemoteAgent } from './connect-remote-agent';
import { getRemoteAgentLocation } from './agent-location';
import { getAgentById } from './getAgentById';

const RECONCILE_INTERVAL_MS = 2_000;
const SESSIONS_REQUEST_TIMEOUT_MS = 10_000;
// Hard ceiling on one reconcile pass. Every operation inside a pass is
// individually time-bounded (channel opens, the /sessions request), so this
// should never fire — it is the backstop that guarantees the `inFlight` guard
// can never wedge permanently and silently stop reconciliation for good.
const TICK_DEADLINE_MS = 45_000;
// How long a just-deleted conversation id is refused re-adoption. The delete
// path sends the sidecar a /disconnect, but a reconcile tick can race it (both
// run on a ~2s cadence) and re-adopt the id from a stale /sessions snapshot
// before the disconnect lands — recreating the ghost row we just deleted. The
// tombstone bridges that window; a few reconcile intervals is ample.
const TOMBSTONE_TTL_MS = 10_000;
// Consecutive reconcile passes a reconciler-adopted session must be absent from
// the sidecar `/sessions` snapshot before its local row is pruned. This is the
// backstop for a client that missed the `session-terminated` push (e.g. it
// adopted a session but never opened it, so it has no relay polling `/events`).
// A threshold (rather than pruning on first absence) tolerates the brief empty
// window after a sidecar restart, before the agents re-post their hooks. Only
// successful polls count — a failed fetch throws and skips the pass entirely.
const PRUNE_MISSING_THRESHOLD = 3;

interface SidecarSessionsResponse {
  sessions: Array<{ sessionId: string; roomId: string | null }>;
}

/**
 * Surfaces the sessions a remote agent's on-VM sidecar started on its own (the
 * notification watcher auto-starting a session when the agent is addressed while
 * switchdash was closed) in the switchdash UI.
 *
 * The VM is the source of truth: it mints the conversation id and runs the agent
 * in a tmux pane with no switchdash DB row. This reconciler polls the sidecar's
 * `GET /sessions` snapshot and, for each conversation id switchdash has never
 * seen, creates a session row with `id = the VM's conversation id`. Because the
 * tmux session name is derived deterministically from that id, the normal
 * session-start path then *attaches* to the already-running pane (same as the
 * post-reconnect rehydrate) rather than spawning a second agent — so the session
 * appears live in the UI, with its real terminal and its hook-event relay.
 *
 * One periodic poll per watched remote agent. Idempotent: an already-known
 * conversation id is skipped, so re-polling only ever adds newly-spawned
 * sessions. The sidecar endpoint (port + token) is resolved fresh each cycle, so
 * a sidecar that restarted — or a VM that rebooted — is re-ensured and its new
 * token picked up automatically.
 */
class RemoteSessionReconciler {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  /** Agents with a reconcile pass in flight, so overlapping ticks don't double-create. */
  private readonly inFlight = new Set<string>();
  /** Cached sidecar endpoint per agent, so a steady-state tick doesn't re-ensure
   * (rewrite the spec, reattach) every tick — only when the cached poll fails. */
  private readonly endpoints = new Map<string, SidecarEndpoint>();
  /** sessionId → expiry ts for just-deleted sessions we must not re-adopt. */
  private readonly tombstones = new Map<string, number>();
  /** agentId → conversation ids this reconciler adopted (candidates for pruning). */
  private readonly adopted = new Map<string, Set<string>>();
  /** sessionId → consecutive reconcile passes it has been absent from `/sessions`. */
  private readonly missingStreak = new Map<string, number>();
  /** sidecar key (host::repoDir) → agentId currently reconciling that sidecar.
   * The sidecar — and its /sessions snapshot — is scoped to host+dir, so two
   * agents sharing a dir would double-poll it and race to adopt the same
   * conversation ids. One reconciler per sidecar; duplicates stop themselves. */
  private readonly sidecarKeys = new Map<string, string>();

  constructor() {
    // A remote session deliberately deleted on any client is broadcast by the
    // sidecar and surfaced here (the owning provider has already torn down its
    // PTY). Delete the local row + tombstone it so this client stops showing a
    // ghost and the next reconcile tick cannot re-adopt it from a stale snapshot.
    sessionHooks.on('session:remote-terminated', ({ terminatedSessionId }) => {
      void this.handleRemoteTerminated(terminatedSessionId);
    });
  }

  private async handleRemoteTerminated(sessionId: string): Promise<void> {
    if (await this.removeLocalSession(sessionId)) {
      log.info('RemoteSessionReconciler: removed remotely-terminated session', { sessionId });
    }
  }

  /**
   * Delete a session's local row, tombstone it (so the next reconcile tick cannot
   * re-adopt it from a stale snapshot), drop it from the adopted/missing tracking,
   * and emit `session:deleted` so the UI updates. Returns false (and does not
   * emit) if the DB delete fails. Idempotent — deleting an already-gone row is a
   * no-op. Shared by the `session-terminated` push and the vanished-session prune.
   */
  private async removeLocalSession(sessionId: string): Promise<boolean> {
    this.tombstone(sessionId);
    for (const ids of this.adopted.values()) ids.delete(sessionId);
    this.missingStreak.delete(sessionId);
    let deleted: { changes: number };
    let agentId: string | undefined;
    try {
      const [row] = await db
        .select({ agentId: sessions.agentId })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      agentId = row?.agentId;
      deleted = await db.delete(sessions).where(eq(sessions.id, sessionId));
    } catch (error) {
      log.warn('RemoteSessionReconciler: failed to delete session row', {
        sessionId,
        error: String(error),
      });
      return false;
    }
    // A no-op delete (row already gone — every relay/instance delivers the same
    // `session-terminated`) still "succeeds", so gate the event + log on an
    // actual row removal to avoid redundant deleted-events and log spam.
    if (deleted.changes === 0) return false;
    sessionHooks._emit('session:deleted', sessionId);
    // Tell the renderer to drop the row too. Unlike a user-initiated delete
    // (the renderer removes it itself), this removal originates in the main
    // process, so without an IPC event every attached window shows a ghost row
    // until restart; stores that own the session drop it by id.
    log.info('RemoteSessionReconciler: notifying UI to remove session (remote-driven delete)', {
      sessionId,
    });
    events.emit(sessionDeletedChannel, { sessionId });
    return true;
  }

  /**
   * Refuse re-adoption of a conversation id for a short window after switchdash
   * deletes it, closing the race where a reconcile tick re-adopts it from a stale
   * sidecar `/sessions` snapshot before the delete's `/disconnect` lands.
   */
  tombstone(sessionId: string): void {
    this.tombstones.set(sessionId, Date.now() + TOMBSTONE_TTL_MS);
  }

  private isTombstoned(sessionId: string): boolean {
    const expiry = this.tombstones.get(sessionId);
    if (expiry === undefined) return false;
    if (expiry <= Date.now()) {
      this.tombstones.delete(sessionId);
      return false;
    }
    return true;
  }

  /** Begin periodic reconciliation for a remote agent. Idempotent. */
  start(agentId: string): void {
    if (this.timers.has(agentId)) return;
    const timer = setInterval(() => void this.tick(agentId), RECONCILE_INTERVAL_MS);
    this.timers.set(agentId, timer);
    void this.tick(agentId);
    log.info('RemoteSessionReconciler: started', { agentId });
  }

  /** Stop reconciling one remote agent (auto_session off / shutdown). */
  stop(agentId: string): void {
    const timer = this.timers.get(agentId);
    this.endpoints.delete(agentId);
    for (const [key, holder] of this.sidecarKeys) {
      if (holder === agentId) this.sidecarKeys.delete(key);
    }
    const adoptedIds = this.adopted.get(agentId);
    if (adoptedIds) {
      for (const id of adoptedIds) this.missingStreak.delete(id);
      this.adopted.delete(agentId);
    }
    if (!timer) return;
    clearInterval(timer);
    this.timers.delete(agentId);
    log.info('RemoteSessionReconciler: stopped', { agentId });
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.endpoints.clear();
    this.tombstones.clear();
    this.adopted.clear();
    this.missingStreak.clear();
    this.sidecarKeys.clear();
  }

  private async tick(agentId: string): Promise<void> {
    if (this.inFlight.has(agentId)) return;
    this.inFlight.add(agentId);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.reconcileOnce(agentId),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error(`reconcile pass exceeded ${TICK_DEADLINE_MS}ms`)),
            TICK_DEADLINE_MS
          );
        }),
      ]);
    } catch (error) {
      log.warn('RemoteSessionReconciler: reconcile failed', { agentId, error: String(error) });
    } finally {
      if (deadline) clearTimeout(deadline);
      this.inFlight.delete(agentId);
    }
  }

  private async reconcileOnce(agentId: string): Promise<void> {
    const agent = await getAgentById(agentId);
    const location = agent ? await getRemoteAgentLocation(agent) : null;
    if (!agent || !location) {
      this.stop(agentId);
      this.endpoints.delete(agentId);
      return;
    }

    if (!this.claimSidecar(agentId, location)) return;

    // The manager is mid-backoff rebuilding the transport: let it finish
    // rather than racing it with connect attempts every tick. Disconnected and
    // suspended states DO proceed — connectRemoteAgent's connect() is what
    // revives them.
    const connectionState = sshConnectionManager.getConnectionState(
      sshConnectionIdForHost(location.sshHost)
    );
    if (connectionState === 'reconnecting') return;

    const conn = await connectRemoteAgent(agent);
    const response = await this.fetchSessions(agent, conn);
    const vmSessions = response.sessions ?? [];
    const vmIds = new Set(vmSessions.map((s) => s.sessionId));

    // Check adoption candidates against ALL local sessions, not just this
    // agent's: a conversation id is globally unique (it is the sessions PK),
    // and the sidecar snapshot carries no agent attribution — another agent
    // may legitimately own the row already.
    const known = vmIds.size
      ? new Set(
          (
            await db
              .select({ id: sessions.id })
              .from(sessions)
              .where(inArray(sessions.id, [...vmIds]))
          ).map((r) => r.id)
        )
      : new Set<string>();
    for (const vm of vmSessions) {
      if (known.has(vm.sessionId)) continue;
      if (this.isTombstoned(vm.sessionId)) continue;
      await this.adoptSession(agent, vm.sessionId, vm.roomId);
    }

    await this.pruneVanished(agentId, vmIds);
  }

  /**
   * Claim the agent's sidecar (host+repoDir) for reconciliation. Returns false
   * — and stops this agent's loop — when another live agent already reconciles
   * the same sidecar, so shared-dir agents cannot double-poll one snapshot and
   * race each other's adoptions.
   */
  private claimSidecar(agentId: string, location: { id: string }): boolean {
    const key = location.id;
    const holder = this.sidecarKeys.get(key);
    if (holder !== undefined && holder !== agentId && this.timers.has(holder)) {
      log.info('RemoteSessionReconciler: sidecar already reconciled by another agent — stopping', {
        agentId,
        key,
        holder,
      });
      this.stop(agentId);
      return false;
    }
    this.sidecarKeys.set(key, agentId);
    return true;
  }

  /**
   * Remove reconciler-adopted rows the VM no longer reports. A session this client
   * only ever adopted (never opened) has no relay to receive the `session-terminated`
   * push, so without this it would keep a ghost row that could re-attach into a
   * blank tmux session. Only prune after `PRUNE_MISSING_THRESHOLD` consecutive
   * absences to ride out the empty window after a sidecar restart.
   */
  private async pruneVanished(agentId: string, vmIds: Set<string>): Promise<void> {
    const adoptedIds = this.adopted.get(agentId);
    if (!adoptedIds) return;
    for (const id of [...adoptedIds]) {
      if (vmIds.has(id) || this.isTombstoned(id)) {
        this.missingStreak.delete(id);
        continue;
      }
      const streak = (this.missingStreak.get(id) ?? 0) + 1;
      if (streak < PRUNE_MISSING_THRESHOLD) {
        this.missingStreak.set(id, streak);
        continue;
      }
      if (await this.removeLocalSession(id)) {
        log.info('RemoteSessionReconciler: pruned VM session no longer reported', {
          agentId,
          sessionId: id,
        });
      }
    }
  }

  /**
   * Poll the sidecar's `/sessions` using the cached endpoint; only re-ensure the
   * sidecar (which rewrites the launch spec and reattaches) when the cached poll
   * fails — e.g. the sidecar restarted and rotated its token. Keeps a steady-state
   * tick to a single cheap `/sessions` request over the pooled SSH connection.
   */
  private async fetchSessions(
    agent: Agent,
    conn: Awaited<ReturnType<typeof connectRemoteAgent>>
  ): Promise<SidecarSessionsResponse> {
    const cached = this.endpoints.get(agent.id);
    if (cached) {
      try {
        return await this.pollSessions(conn.proxy, cached);
      } catch (error) {
        log.debug('RemoteSessionReconciler: cached endpoint poll failed — re-probing sidecar', {
          agentId: agent.id,
          error: String(error),
        });
        this.endpoints.delete(agent.id);
      }
    }
    // Probe, never launch: discovery runs for every remote agent (not just
    // auto_session ones), so a merely-configured agent must not cause a sidecar
    // to be started. When none is running there is nothing to discover.
    const endpoint = await probeAgentSidecar({
      providerId: agent.providerId,
      repoDir: conn.remoteRepoDir,
      deeplinkScheme: DEEPLINK_SCHEME,
      ctx: conn.ctx,
      connectionId: conn.connectionId,
      host: conn.host,
    });
    if (!endpoint) return { sessions: [] };
    this.endpoints.set(agent.id, endpoint);
    return this.pollSessions(conn.proxy, endpoint);
  }

  private async pollSessions(
    proxy: Awaited<ReturnType<typeof connectRemoteAgent>>['proxy'],
    endpoint: SidecarEndpoint
  ): Promise<SidecarSessionsResponse> {
    const channel = await proxy.forwardOut(endpoint.port);
    try {
      return await httpGetJsonOverChannel<SidecarSessionsResponse>(channel, {
        port: endpoint.port,
        token: endpoint.token,
        path: '/sessions',
        timeoutMs: SESSIONS_REQUEST_TIMEOUT_MS,
      });
    } finally {
      channel.destroy();
    }
  }

  /**
   * Create a switchdash session row whose id equals the VM's conversation id, so
   * the session-start path attaches to the running tmux pane rather than spawning
   * a fresh agent. No initial prompt — the agent is already connected to the room
   * and processing the waiting message.
   */
  private async adoptSession(
    agent: Agent,
    sessionId: string,
    roomId: string | null
  ): Promise<void> {
    const result = await sessionService.createSession({
      id: sessionId,
      agentId: agent.id,
      title: roomId ? `Switch room ${roomId}` : 'Remote session',
      autoApprove: true,
    });
    if (!result.success) {
      if (result.error.type === 'already-exists') {
        // Another creator (a second client, or a racing pass) minted the row
        // between our snapshot and the insert — it is adopted, just not by us.
        log.info('RemoteSessionReconciler: session row already exists — skipping adoption', {
          agentId: agent.id,
          sessionId,
        });
        return;
      }
      log.warn('RemoteSessionReconciler: failed to adopt VM session', {
        agentId: agent.id,
        sessionId,
        roomId,
        error: JSON.stringify(result.error),
      });
      return;
    }
    // createSession provisions the runtime inline but emits only session:created,
    // not session:provisioned — without the latter an open renderer leaves the
    // session stuck "Setting up workspace…". provisionWorkspace is idempotent and
    // emits the provisioned event the renderer needs.
    await sessionService.provisionWorkspace(sessionId).catch((error) => {
      log.warn('RemoteSessionReconciler: post-adopt provision-reconcile failed', {
        agentId: agent.id,
        sessionId,
        error: String(error),
      });
    });
    let adoptedIds = this.adopted.get(agent.id);
    if (!adoptedIds) {
      adoptedIds = new Set();
      this.adopted.set(agent.id, adoptedIds);
    }
    adoptedIds.add(sessionId);
    this.missingStreak.delete(sessionId);
    log.info('RemoteSessionReconciler: adopted VM-spawned session', {
      agentId: agent.id,
      sessionId,
      roomId,
    });
  }
}

export const remoteSessionReconciler = new RemoteSessionReconciler();
