import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getRemoteAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { SWITCH_SUBAGENTS_DIR_RELATIVE } from '@main/core/agents/switch-settings-paths';
import { getLocationById } from '@main/core/locations/store';
import { sessionService } from '@main/core/sessions/session-service';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { sessionRoomChangedChannel } from '@shared/core/switch-rooms/switchRoomEvents';
import {
  listAutoSessionAgentIds,
  listAutoSessionSubagents,
  setAutoSessionAgent,
  setAutoSessionSubagent,
} from './auto-session-store';
import {
  readSwitchAgentCredentials,
  readSwitchAgentCredentialsFromSettings,
  type SwitchAgentCredentials,
} from './switch-credentials';
import type { AgentBridgeEventResponse } from './switch-event-format';
import { switchRoomService } from './switch-room-service';

const NOTIF_POLL_TIMEOUT_S = 10;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
// Refresh the global "watching" heartbeat well under the server's ALWAYS_ON_TTL
// (90s) so a dormant agent reports DORMANT (and replies "Starting a session…")
// while switchdash is up.
const WATCH_HEARTBEAT_INTERVAL_MS = 30_000;
const SPAWN_MAX_ATTEMPTS = 3;
const SPAWN_RETRY_DELAY_MS = 2000;
// How long a room stays "spawn in flight" before the guard is cleared. Covers
// the boot+connect window; once the session connects, the live-session check
// no-ops further notifications anyway. If the spawn failed, clearing lets the
// next notification retry.
const INFLIGHT_TTL_MS = 120_000;

interface AgentWatcher {
  abort: AbortController;
  /** Map key: the local agent id for a parent, or `parentId::subagentName`. */
  key: string;
  /** Local agent that owns spawned sessions (the parent for a subagent). */
  localAgentId: string;
  /** When set, spawn sessions as this Claude Code subagent of `localAgentId`. */
  subagentName?: string;
  creds: SwitchAgentCredentials;
  /** Room ids with a spawn in flight (booting / connecting) → guards against
   * duplicate spawns while a notification storm lands during the boot window. */
  inFlight: Map<string, ReturnType<typeof setTimeout>>;
}

/** Watcher map key for a subagent (distinct from its parent's plain id). */
function subagentWatcherKey(parentAgentId: string, name: string): string {
  return `${parentAgentId}::${name}`;
}

/** Resolve the working-directory path of a local agent's location. */
async function getAgentLocalDir(localAgentId: string): Promise<string | null> {
  const agent = await getAgentById(localAgentId);
  if (!agent) return null;
  const location = await getLocationById(agent.locationId);
  if (!location || location.sshHost !== null) return null;
  return location.dir;
}

/** Refresh the agent's global "watching" heartbeat. Throws on non-OK. */
async function postWatchHeartbeat(
  creds: SwitchAgentCredentials,
  signal: AbortSignal
): Promise<void> {
  const resp = await fetch(`${creds.apiEndpoint}/agents/${creds.agentId}/watch/heartbeat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    signal,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
}

/** Post a message to a room on the agent's behalf (used for the spawn-failure
 * notice). Best-effort; throws on non-OK so the caller can log. */
async function postRoomMessage(
  creds: SwitchAgentCredentials,
  roomId: string,
  content: string
): Promise<void> {
  const resp = await fetch(`${creds.apiEndpoint}/agents/${creds.agentId}/message`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ room_id: roomId, content }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
}

/**
 * Watches the Switch notification stream for `auto_session` agents and spins up
 * a Claude Code session — connected to the room and ready to receive the
 * waiting message — whenever the agent is addressed in a room where it has no
 * live session. The triggering message is delivered by the normal per-room
 * poller once the spawned session connects (the notification stream is a
 * separate queue, so the event still waits in the room's event queue).
 *
 * One watcher per agent: a single agent-level long-poll multiplexed across all
 * the agent's rooms, plus a global "watching" heartbeat. Spawns one session per
 * room. The notification stream never drains the per-room queues, so live
 * session pollers are unaffected.
 */
class AutoSessionWatcher {
  private readonly watchers = new Map<string, AgentWatcher>();
  private roomChangeUnsub: (() => void) | null = null;

  /** Start watchers for every agent and subagent currently mirrored as auto_session. */
  async initialize(): Promise<void> {
    this.subscribeToRoomConnections();
    const ids = await listAutoSessionAgentIds();
    for (const agentId of ids) {
      // Self-heal stale mirror entries: an agent deleted by a build that did not
      // clean up (see deleteAgent) leaves its id here. Prune it so we do not warn
      // on every boot, and skip starting a watcher we could never credential.
      if (!(await getAgentById(agentId))) {
        await setAutoSessionAgent(agentId, false);
        log.info('AutoSessionWatcher: pruned stale auto_session mirror entry', { agentId });
        continue;
      }
      await this.startForAgent(agentId).catch((error) => {
        log.warn('AutoSessionWatcher: failed to start watcher at init', {
          agentId,
          error: String(error),
        });
      });
    }
    const subagents = await listAutoSessionSubagents();
    for (const { parentAgentId, name } of subagents) {
      if (!(await getAgentById(parentAgentId))) {
        await setAutoSessionSubagent(parentAgentId, name, false);
        log.info('AutoSessionWatcher: pruned stale auto_session subagent mirror entry', {
          parentAgentId,
          name,
        });
        continue;
      }
      await this.startForSubagent(parentAgentId, name).catch((error) => {
        log.warn('AutoSessionWatcher: failed to start subagent watcher at init', {
          parentAgentId,
          name,
          error: String(error),
        });
      });
    }
    log.info('AutoSessionWatcher: initialised', { watching: this.watchers.size });
  }

  /**
   * When a session actually connects to a room, hand the per-room spawn guard
   * from `inFlight` (which covers only the boot window) over to the live-session
   * check by clearing the in-flight entry. Without this the entry lingers until
   * INFLIGHT_TTL_MS fires, so a session torn down shortly after connecting would
   * leave the room blocked from respawning for up to that TTL. Disconnect events
   * (roomId/agentId null) are ignored — the live-session check already reflects
   * them, and we want the next notification to respawn immediately.
   */
  private subscribeToRoomConnections(): void {
    if (this.roomChangeUnsub) return;
    this.roomChangeUnsub = events.on(sessionRoomChangedChannel, ({ roomId, agentId }) => {
      if (!roomId || !agentId) return;
      for (const watcher of this.watchers.values()) {
        if (watcher.creds.agentId === agentId) this.clearInFlight(watcher, roomId);
      }
    });
  }

  private clearInFlight(watcher: AgentWatcher, roomId: string): void {
    const timer = watcher.inFlight.get(roomId);
    if (timer) clearTimeout(timer);
    watcher.inFlight.delete(roomId);
  }

  /** Start (or restart) the watcher for one local agent. Idempotent. */
  async startForAgent(localAgentId: string): Promise<void> {
    if (this.watchers.has(localAgentId)) return;

    // Remote agents are watched by their on-VM notification-watcher daemon, so
    // it keeps auto-starting sessions while switchdash is closed. Watching them
    // here too would double-poll the agent's notification stream, so skip.
    const agent = await getAgentById(localAgentId);
    if (agent && (await getRemoteAgentLocation(agent))) {
      log.debug('AutoSessionWatcher: skipping remote agent (watched on its VM)', { localAgentId });
      return;
    }

    const rootPath = await getAgentLocalDir(localAgentId);
    if (!rootPath) {
      log.warn('AutoSessionWatcher: no local dir for agent; cannot read credentials', {
        localAgentId,
      });
      return;
    }
    const creds = await readSwitchAgentCredentials(rootPath, log);
    if (!creds) {
      log.warn('AutoSessionWatcher: missing Switch credentials; cannot watch', {
        localAgentId,
        dir: rootPath,
      });
      return;
    }

    this.startWatcher({ key: localAgentId, localAgentId, creds });
  }

  /**
   * Start (or restart) the watcher for one Claude Code subagent of a parent
   * agent. Polls the subagent's own Switch notification stream (its credentials
   * file) and spawns sessions launched as that subagent. Idempotent.
   */
  async startForSubagent(parentAgentId: string, name: string): Promise<void> {
    const key = subagentWatcherKey(parentAgentId, name);
    if (this.watchers.has(key)) return;

    const rootPath = await getAgentLocalDir(parentAgentId);
    if (!rootPath) {
      log.warn('AutoSessionWatcher: no local dir for parent agent; cannot watch subagent', {
        parentAgentId,
        name,
      });
      return;
    }
    const settingsPath = path.join(
      rootPath,
      SWITCH_SUBAGENTS_DIR_RELATIVE,
      `${name}.settings.json`
    );
    const creds = await readSwitchAgentCredentialsFromSettings(settingsPath, log);
    if (!creds) {
      log.warn('AutoSessionWatcher: missing subagent credentials; cannot watch', {
        parentAgentId,
        name,
        settingsPath,
      });
      return;
    }

    this.startWatcher({ key, localAgentId: parentAgentId, subagentName: name, creds });
  }

  private startWatcher(init: {
    key: string;
    localAgentId: string;
    subagentName?: string;
    creds: SwitchAgentCredentials;
  }): void {
    const abort = new AbortController();
    const watcher: AgentWatcher = { ...init, abort, inFlight: new Map() };
    this.watchers.set(init.key, watcher);
    log.info('AutoSessionWatcher: watching agent', {
      key: init.key,
      localAgentId: init.localAgentId,
      subagentName: init.subagentName,
      agentId: init.creds.agentId,
    });

    void this.notificationLoop(watcher);
    void this.watchHeartbeatLoop(watcher);
  }

  /** Stop watching one local agent (toggle off / shutdown). */
  stopForAgent(localAgentId: string): void {
    this.stopByKey(localAgentId);
  }

  /** Stop watching one subagent (toggle off / shutdown). */
  stopForSubagent(parentAgentId: string, name: string): void {
    this.stopByKey(subagentWatcherKey(parentAgentId, name));
  }

  private stopByKey(key: string): void {
    const watcher = this.watchers.get(key);
    if (!watcher) return;
    watcher.abort.abort();
    for (const timer of watcher.inFlight.values()) clearTimeout(timer);
    watcher.inFlight.clear();
    this.watchers.delete(key);
    log.info('AutoSessionWatcher: stopped watching agent', { key });
  }

  /** React to a toggle of the agent's auto_session setting. */
  async reconcile(localAgentId: string, enabled: boolean): Promise<void> {
    if (enabled) await this.startForAgent(localAgentId);
    else this.stopForAgent(localAgentId);
  }

  /** React to a toggle of a subagent's auto_session setting. */
  async reconcileSubagent(parentAgentId: string, name: string, enabled: boolean): Promise<void> {
    if (enabled) await this.startForSubagent(parentAgentId, name);
    else this.stopForSubagent(parentAgentId, name);
  }

  dispose(): void {
    this.roomChangeUnsub?.();
    this.roomChangeUnsub = null;
    for (const id of [...this.watchers.keys()]) this.stopForAgent(id);
  }

  private async watchHeartbeatLoop(watcher: AgentWatcher): Promise<void> {
    const { abort, creds } = watcher;
    log.debug('AutoSessionWatcher: watch-heartbeat loop started', {
      localAgentId: watcher.localAgentId,
      agentId: creds.agentId,
      intervalMs: WATCH_HEARTBEAT_INTERVAL_MS,
    });
    while (!abort.signal.aborted) {
      try {
        await postWatchHeartbeat(creds, abort.signal);
      } catch (error) {
        if (abort.signal.aborted) return;
        log.warn('AutoSessionWatcher: watch heartbeat error', {
          agentId: creds.agentId,
          error: String(error),
        });
      }
      await new Promise((r) => setTimeout(r, WATCH_HEARTBEAT_INTERVAL_MS));
    }
  }

  private async notificationLoop(watcher: AgentWatcher): Promise<void> {
    const { abort, creds } = watcher;
    const url = `${creds.apiEndpoint}/agents/${creds.agentId}/notifications?timeout=${NOTIF_POLL_TIMEOUT_S}`;
    let backoff = INITIAL_BACKOFF_MS;
    log.debug('AutoSessionWatcher: notification loop started', {
      localAgentId: watcher.localAgentId,
      agentId: creds.agentId,
      url,
    });

    while (!abort.signal.aborted) {
      try {
        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${creds.token}` },
          signal: abort.signal,
        });
        if (resp.status === 204) {
          backoff = INITIAL_BACKOFF_MS;
          continue;
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);

        backoff = INITIAL_BACKOFF_MS;
        const data = (await resp.json()) as AgentBridgeEventResponse;
        for (const event of data.events) {
          this.handleNotification(watcher, event.room_id);
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        log.warn('AutoSessionWatcher: notification poll error', {
          agentId: creds.agentId,
          error: String(error),
        });
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  /** Decide whether to spawn for a notified room, with a per-room in-flight guard. */
  private handleNotification(watcher: AgentWatcher, roomId: string): void {
    // A live session is already attending this room — the existing per-room
    // poller delivers the message; nothing to do.
    const hasLiveSession = switchRoomService
      .getConnections()
      .some((c) => c.roomId === roomId && c.agentId === watcher.creds.agentId);
    if (hasLiveSession) return;
    if (watcher.inFlight.has(roomId)) return;

    const timer = setTimeout(() => watcher.inFlight.delete(roomId), INFLIGHT_TTL_MS);
    watcher.inFlight.set(roomId, timer);

    void this.spawnForRoom(watcher, roomId).catch((error) => {
      log.warn('AutoSessionWatcher: spawn failed', {
        localAgentId: watcher.localAgentId,
        roomId,
        error: String(error),
      });
    });
  }

  private async spawnForRoom(watcher: AgentWatcher, roomId: string): Promise<void> {
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= SPAWN_MAX_ATTEMPTS; attempt += 1) {
      if (watcher.abort.signal.aborted) return;
      try {
        const result = await sessionService.createSession({
          id: randomUUID(),
          agentId: watcher.localAgentId,
          subagentName: watcher.subagentName,
          title: `Switch room ${roomId}`,
          // Bootstrap: tell the fresh session to join the room. Once it calls
          // connect_to_room, the connect hook starts the per-room poller, which
          // injects the message waiting in the room's event queue.
          initialPrompt: `connect to switch room ${roomId}`,
          autoApprove: true,
        });
        if (result.success) {
          log.info('AutoSessionWatcher: spawned session for room', {
            localAgentId: watcher.localAgentId,
            roomId,
            sessionId: result.data.session.id,
          });
          // createSession provisions the runtime inline but emits only
          // session:created — not session:provisioned. Without the latter an
          // open renderer leaves the session stuck "Setting up workspace…"
          // (it never reconciles to ready). provisionWorkspace is idempotent
          // (fast-paths on the already-registered runtime) and emits the
          // provisioned event the renderer needs.
          await sessionService.provisionWorkspace(result.data.session.id).catch((error) => {
            log.warn('AutoSessionWatcher: post-spawn provision-reconcile failed', {
              roomId,
              sessionId: result.data.session.id,
              error: String(error),
            });
          });
          return;
        }
        lastError = JSON.stringify(result.error);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt < SPAWN_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, SPAWN_RETRY_DELAY_MS));
      }
    }

    // Bounded retries exhausted — be honest in the room rather than leaving the
    // human hanging on the backend's "Starting a session…" promise. Clear the
    // in-flight guard so a later notification can try again.
    this.clearInFlight(watcher, roomId);
    log.error('AutoSessionWatcher: could not spawn session after retries', {
      localAgentId: watcher.localAgentId,
      roomId,
      error: lastError,
    });
    await postRoomMessage(
      watcher.creds,
      roomId,
      "I tried to start a session to handle this but couldn't — my operator may need to start one manually."
    ).catch((error) => {
      log.warn('AutoSessionWatcher: failed to post spawn-failure notice', {
        roomId,
        error: String(error),
      });
    });
  }
}

export const autoSessionWatcher = new AutoSessionWatcher();
