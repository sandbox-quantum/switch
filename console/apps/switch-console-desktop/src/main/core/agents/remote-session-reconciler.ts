import { eq, inArray } from 'drizzle-orm';
import { DEEPLINK_SCHEME } from '@main/app/deeplinks';
import { probeAgentSidecar } from '@main/core/agent-runtime/impl/ensure-agent-sidecar';
import type { SidecarEndpoint } from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import { httpGetJsonOverChannel } from '@main/core/agent-runtime/impl/sidecar-http';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import type { HostReachabilityChange } from '@main/core/remote-hosts/host-reachability-service';
import { hostReachabilityService } from '@main/core/remote-hosts/production-host-reachability';
import { formatProvisionSessionError } from '@main/core/sessions/provision-session-error';
import { sessionHooks } from '@main/core/sessions/session-hooks';
import { sessionService } from '@main/core/sessions/session-service';
import { sshConnectionManager } from '@main/core/ssh/lifecycle/production-ssh-connection-manager';
import { switchRoomService } from '@main/core/switch-rooms/switch-room-service';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import { makePtyId } from '@shared/core/pty/ptyId';
import { HostUnreachableError } from '@shared/core/remote-hosts/reachability';
import { sessionDeletedChannel } from '@shared/core/sessions/sessionEvents';
import { agentLaunchSpecialization } from './agent-launch-config';
import { getRemoteAgentLocation } from './agent-location';
import { connectRemoteAgent } from './connect-remote-agent';
import { getAgentById } from './getAgentById';

const RECONCILE_INTERVAL_MS = 2_000;
const SESSIONS_REQUEST_TIMEOUT_MS = 10_000;
// Hard ceiling on one reconcile pass. Every operation inside a pass is
// individually time-bounded (channel opens, the /sessions request), so this
// should never fire — it is the backstop that guarantees the `inFlight` guard
// can never wedge permanently and silently stop reconciliation for good.
const TICK_DEADLINE_MS = 45_000;
// How long a just-deleted session id is refused re-adoption. The delete
// path sends the sidecar a /disconnect, but a reconcile tick can race it (both
// run on a ~2s cadence) and re-adopt the id from a stale /sessions snapshot
// before the disconnect lands — recreating the ghost row we just deleted. The
// tombstone bridges that window; a few reconcile intervals is ample.
const TOMBSTONE_TTL_MS = 10_000;
// Consecutive reconcile passes a reconciler-adopted session must be absent from
// the sidecar `/sessions` snapshot before its local row is pruned. This is the
// backstop for a client that missed the `session-terminated` push (e.g. it
// adopted a session but never opened it, so it has no relay polling `/events`).
// A threshold (rather than pruning on first absence) absorbs a one-off odd
// snapshot. It is NOT what covers a sidecar restart: the sidecar restores its
// session registry from durable state, so a restarted sidecar reports its
// sessions immediately rather than going empty until the agents next speak.
// Only successful polls count — an unreachable sidecar skips the pass entirely
// rather than counting as an absence.
const PRUNE_MISSING_THRESHOLD = 3;

interface SidecarSessionsResponse {
  sessions: Array<{ sessionId: string; roomId: string | null }>;
}

/**
 * Outcome of a poll. "The VM says it has no sessions" and "I could not ask the
 * VM" are different facts and only the first is evidence a session is gone —
 * conflating them meant an unreachable sidecar looked exactly like an empty one
 * and drove the client to delete rows for sessions that were still running.
 */
type SessionsSnapshot =
  | { ok: true; sessions: Array<{ sessionId: string; roomId: string | null }> }
  | { ok: false; reason: string };

/**
 * Surfaces the sessions a remote agent's on-VM sidecar started on its own (the
 * notification watcher auto-starting a session when the agent is addressed while
 * Switch Console was closed) in the Switch Console UI.
 *
 * The VM is the source of truth: it mints the session id and runs the agent
 * in a tmux pane with no Switch Console DB row. This reconciler polls the sidecar's
 * `GET /sessions` snapshot and, for each session id Switch Console has never
 * seen, creates a session row with `id = the VM's session id`. Because the
 * tmux session name is derived deterministically from that id, the normal
 * session-start path then *attaches* to the already-running pane (same as the
 * post-reconnect rehydrate) rather than spawning a second agent — so the session
 * appears live in the UI, with its real terminal and its hook-event relay.
 *
 * One periodic poll per watched remote agent. Idempotent: an already-known
 * session id is skipped, so re-polling only ever adds newly-spawned
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
  /** agentId → session ids this reconciler adopted (candidates for pruning). */
  private readonly adopted = new Map<string, Set<string>>();
  /** sessionId → consecutive reconcile passes it has been absent from `/sessions`. */
  private readonly missingStreak = new Map<string, number>();
  /** sidecar key (host::repoDir::credsSlug) → agentId currently reconciling that
   * sidecar. A sidecar — and its /sessions snapshot — is scoped to host+dir+agent
   * name (ensureAgentSidecar keys it by credsSlug = agent.name), so two agents in
   * the SAME dir but with different names each own a distinct sidecar and must both
   * reconcile. Only two agent rows resolving to the same host+dir+name share one
   * sidecar; those double-poll and race to adopt the same ids, so one reconciler
   * per sidecar — those duplicates stop themselves. */
  private readonly sidecarKeys = new Map<string, string>();

  constructor() {
    // A remote session deliberately deleted on any client is broadcast by the
    // sidecar and surfaced here (the owning provider has already torn down its
    // PTY). Delete the local row + tombstone it so this client stops showing a
    // ghost and the next reconcile tick cannot re-adopt it from a stale snapshot.
    sessionHooks.on('session:remote-terminated', ({ terminatedSessionId }) => {
      void this.handleRemoteTerminated(terminatedSessionId);
    });

    // A host coming back is the signal to resume the agents that were paused on
    // it — without this they would idle until their next 2s tick, which is
    // harmless, but ticking immediately makes recovery feel instant and keeps
    // the paused/resumed transition symmetric.
    hostReachabilityService.on('change', ({ current }: HostReachabilityChange) => {
      if (current.status === 'reachable') void this.onHostReachable(current.sshHost);
    });
  }

  /** Tick every agent whose location sits on a host that just became reachable. */
  private async onHostReachable(sshHost: string): Promise<void> {
    for (const agentId of [...this.timers.keys()]) {
      const agent = await getAgentById(agentId);
      const location = agent ? await getRemoteAgentLocation(agent) : null;
      if (location?.sshHost === sshHost) void this.tick(agentId);
    }
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
    // Drop the room badge for a session that is going away, so the renderer
    // does not keep showing a stale room for a row it is about to remove.
    switchRoomService.clearSession(sessionId);
    let deleted: { changes: number };
    try {
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
   * Refuse re-adoption of a session id for a short window after Switch Console
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
      // A host that went unreachable mid-pass is already reported once, loudly,
      // by the reachability service. Repeating it here every 2s per agent is the
      // log flood CHOO-1682 is about.
      if (error instanceof HostUnreachableError) {
        log.debug('RemoteSessionReconciler: host unreachable — pass skipped', {
          agentId,
          sshHost: error.reachability.sshHost,
        });
      } else {
        log.warn('RemoteSessionReconciler: reconcile failed', { agentId, error: String(error) });
      }
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

    // The sidecar is scoped to host+dir+agent name, so the claim key must carry
    // the same credsSlug (agent.name ?? id) the probe uses — else co-located
    // agents with different names collapse onto one claim and all but one are
    // starved of session discovery.
    const sidecarKey = `${location.id}::${agent.name ?? agent.id}`;
    if (!this.claimSidecar(agentId, sidecarKey)) return;

    // The host is known to be down: skip the pass entirely rather than
    // attempting a connect every 2s per agent. Recovery is driven by the
    // reachability service's single backoff probe, and `onHostReachable` ticks
    // this agent the moment the host comes back, so nothing is lost by waiting.
    if (hostReachabilityService.isBlocked(location.sshHost)) return;

    // The manager is mid-backoff rebuilding the transport: let it finish
    // rather than racing it with connect attempts every tick. Disconnected and
    // suspended states DO proceed — connectRemoteAgent's connect() is what
    // revives them.
    const connectionState = sshConnectionManager.getConnectionState(
      sshConnectionIdForHost(location.sshHost)
    );
    if (connectionState === 'reconnecting') return;

    const conn = await connectRemoteAgent(agent);
    const snapshot = await this.fetchSessions(agent, conn);
    // A poll we could not complete tells us nothing about what is running, so
    // this pass makes no adoptions and — crucially — no prunes. Deleting rows
    // because the VM was unreachable is how live sessions used to disappear.
    if (!snapshot.ok) {
      log.debug('RemoteSessionReconciler: sessions poll failed — skipping pass', {
        agentId,
        reason: snapshot.reason,
      });
      return;
    }
    const vmSessions = snapshot.sessions;
    const vmIds = new Set(vmSessions.map((s) => s.sessionId));

    // Check adoption candidates against ALL local sessions, not just this
    // agent's: a session id is globally unique (it is the sessions PK),
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
      if (this.isTombstoned(vm.sessionId)) continue;
      if (!known.has(vm.sessionId)) {
        await this.adoptSession(agent, vm.sessionId, vm.roomId);
      }
      // Mirror the room the sidecar reports into switchRoomService every tick —
      // this is what recovers a session's room after a restart/wake (the row is
      // re-adopted but the room association is otherwise dropped) and reflects a
      // later reconnect/room switch, for both freshly-adopted and already-known
      // sessions.
      //
      // A null room is reported, not ignored. The snapshot is only trusted at
      // all once `snapshot.ok` has passed, and for a session the sidecar owns
      // "no room" is a fact it holds rather than a gap in the poll: the session
      // has not connected yet, or it was evicted from the room it had. Dropping
      // it left an evicted session sitting under a room it no longer attends,
      // beside the session that took it — two sessions in one room, which is
      // the illusion CHOO-1419 is about.
      if (vm.roomId) this.mirrorSessionRoom(agent, vm.sessionId, vm.roomId);
      else switchRoomService.clearSession(vm.sessionId);
    }

    await this.pruneVanished(agentId, vmIds);
  }

  /**
   * Claim the agent's sidecar (host+repoDir+agent name) for reconciliation.
   * Returns false — and stops this agent's loop — when another live agent already
   * reconciles the SAME sidecar (two rows resolving to one host+dir+name), so
   * genuine duplicates cannot double-poll one snapshot and race each other's
   * adoptions. Co-located agents with different names own distinct sidecars, get
   * distinct keys, and both proceed.
   */
  private claimSidecar(agentId: string, sidecarKey: string): boolean {
    const holder = this.sidecarKeys.get(sidecarKey);
    if (holder !== undefined && holder !== agentId && this.timers.has(holder)) {
      log.info('RemoteSessionReconciler: sidecar already reconciled by another agent — stopping', {
        agentId,
        key: sidecarKey,
        holder,
      });
      this.stop(agentId);
      return false;
    }
    this.sidecarKeys.set(sidecarKey, agentId);
    return true;
  }

  /**
   * Remove reconciler-adopted rows the VM no longer reports. A session this client
   * only ever adopted (never opened) has no relay to receive the `session-terminated`
   * push, so without this it would keep a ghost row that could re-attach into a
   * blank tmux session. Only prune after `PRUNE_MISSING_THRESHOLD` consecutive
   * absences, and only on snapshots we actually got — an unreachable sidecar is
   * not evidence of anything and never reaches here.
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
  ): Promise<SessionsSnapshot> {
    const cached = this.endpoints.get(agent.id);
    if (cached) {
      try {
        return { ok: true, sessions: (await this.pollSessions(conn.proxy, cached)).sessions ?? [] };
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
      autoApprove: agent.autoApprove,
      credsSlug: agent.name ?? agent.id,
      agentName: agent.name ?? null,
      specialization: await agentLaunchSpecialization(agent.id),
      ctx: conn.ctx,
      connectionId: conn.connectionId,
      host: conn.host,
    });
    // No sidecar answered the probe. That is not "the agent has no sessions" —
    // it may be restarting, mid-upgrade, or briefly unreachable — so report it
    // as a failed poll and leave the local rows alone.
    if (!endpoint) return { ok: false, reason: 'no sidecar reachable' };
    this.endpoints.set(agent.id, endpoint);
    try {
      return { ok: true, sessions: (await this.pollSessions(conn.proxy, endpoint)).sessions ?? [] };
    } catch (error) {
      this.endpoints.delete(agent.id);
      return { ok: false, reason: String(error) };
    }
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
   * Record, for display, the room the sidecar reports a session is attending.
   * Skipped when the agent has no Switch identity (it cannot be in a room), so
   * the mirrored connection always carries a real Switch agent id. The ptyId is
   * derived deterministically from provider + session id (the same scheme the
   * hook/relay path uses), keeping the connection shape identical whether the
   * room came from a live hook or this snapshot mirror.
   */
  private mirrorSessionRoom(agent: Agent, sessionId: string, roomId: string): void {
    if (!agent.switchAgentId) return;
    switchRoomService.mirrorRemoteSessionRoom(
      { sessionId, providerId: agent.providerId, ptyId: makePtyId(agent.providerId, sessionId) },
      roomId,
      agent.switchAgentId
    );
  }

  /**
   * Create a Switch Console session row whose id equals the VM's session id, so
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
      autoApprove: agent.autoApprove,
      // The VM is already running this session; adoption only needs the row and
      // the sidecar relay that reports on it. A terminal is opened when the user
      // opens the session — a first sync against a busy host would otherwise
      // spawn one PTY per adopted session in a single pass.
      attach: false,
      // Nobody started this here: the agent was already running on the VM and
      // this row is catching up with it, so it is reported apart from the
      // sessions this app actually started.
      startSource: 'adopted',
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
    // session stuck "Setting up session…". provisionSession is idempotent and
    // emits the provisioned event the renderer needs.
    // The failure is a value now, not a rejection: a `.catch` here would never
    // run and the failure would pass in silence.
    const provisioned = await sessionService.provisionSession(sessionId);
    if (!provisioned.success) {
      log.warn('RemoteSessionReconciler: post-adopt provision-reconcile failed', {
        agentId: agent.id,
        sessionId,
        error: formatProvisionSessionError(provisioned.error),
      });
    }
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
