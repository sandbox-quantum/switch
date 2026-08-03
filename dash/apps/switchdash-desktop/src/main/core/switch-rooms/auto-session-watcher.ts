import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { SwitchEventStream } from '@sandbox-quantum/switch-agent-runtime';
import { getRemoteAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import {
  agentSettingsPath,
  SWITCH_SUBAGENTS_DIR_RELATIVE,
} from '@main/core/agents/switch-settings-paths';
import { getLocationById } from '@main/core/locations/store';
import { sessionService } from '@main/core/sessions/session-service';
import { log } from '@main/lib/logger';
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
import { switchNotificationPoller } from './switch-notification-poller';
import { switchRoomService } from './switch-room-service';

const SPAWN_MAX_ATTEMPTS = 3;
const SPAWN_RETRY_DELAY_MS = 2000;
// How long a room stays "spawn in flight" before the guard is cleared.
//
// This covers the window the server cannot: it learns a session exists only
// when that session's connection claims the room, tens of seconds after the
// process starts. Until then the room looks unattended and every further
// addressed message would spawn again. Cleared early once the session
// connects; this TTL is the backstop for a spawn that failed.
const INFLIGHT_TTL_MS = 120_000;

interface AgentWatcher {
  abort: AbortController;
  /** Map key: the local agent id for a parent, or `parentId::agentName`. */
  key: string;
  /** Local agent that owns spawned sessions (the parent for a subagent). */
  localAgentId: string;
  /** When set, spawn sessions as this Claude Code subagent of `localAgentId`. */
  agentName?: string;
  creds: SwitchAgentCredentials;
  /**
   * Room ids with a spawn in flight (booting / connecting) → guards against
   * duplicate spawns while a notification storm lands during the boot window.
   *
   * This is NOT made redundant by the server's room slots. The server goes dark
   * on a room only once the spawned session's connection claims it, which is
   * tens of seconds after we start the process — until then the room genuinely
   * has nobody in it as far as the server can tell, and every further message
   * would spawn another session. No protocol rule can close that window,
   * because the fact "a process is booting here" exists only on this machine.
   */
  inFlight: Map<string, ReturnType<typeof setTimeout>>;
  /** Chosen once per watcher so the connection survives a dropped socket. */
  connectionId: string;
  stream?: SwitchEventStream;
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
    // An in-process subscription, NOT the `events` bus. In main, `events.emit`
    // is webContents.send and `events.on` is ipcMain.on — opposite directions
    // of the renderer bridge — so this listener never fired for a room
    // connected in main. The guard was therefore only ever cleared by its 120s
    // TTL, which is why a room whose session had already arrived kept
    // reporting "a spawn is already in flight".
    this.roomChangeUnsub = switchRoomService.onSessionRoomChanged(({ roomId, agentId }) => {
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
    // Read the agent's own identity from its provider-neutral per-agent file so
    // agents sharing a location watch as themselves; fall back to the location's
    // `.claude/settings.local.json` for un-migrated installs (CHOO-1440).
    const slug = agent?.name ?? localAgentId;
    const creds =
      (await readSwitchAgentCredentialsFromSettings(agentSettingsPath(rootPath, slug), log)) ??
      (await readSwitchAgentCredentials(rootPath, log));
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
    // A subagent's credentials now live in the provider-neutral
    // `.switch/agents/<name>.json`; fall back to the legacy
    // `.claude/switch-subagents/<name>.settings.json` for un-migrated installs
    // (CHOO-1440).
    const legacyPath = path.join(rootPath, SWITCH_SUBAGENTS_DIR_RELATIVE, `${name}.settings.json`);
    const creds =
      (await readSwitchAgentCredentialsFromSettings(agentSettingsPath(rootPath, name), log)) ??
      (await readSwitchAgentCredentialsFromSettings(legacyPath, log));
    if (!creds) {
      log.warn('AutoSessionWatcher: missing subagent credentials; cannot watch', {
        parentAgentId,
        name,
      });
      return;
    }

    this.startWatcher({ key, localAgentId: parentAgentId, agentName: name, creds });
  }

  private startWatcher(init: {
    key: string;
    localAgentId: string;
    agentName?: string;
    creds: SwitchAgentCredentials;
  }): void {
    const abort = new AbortController();
    const watcher: AgentWatcher = {
      ...init,
      abort,
      inFlight: new Map(),
      connectionId: randomUUID(),
    };
    this.watchers.set(init.key, watcher);
    log.info('AutoSessionWatcher: watching agent', {
      key: init.key,
      localAgentId: init.localAgentId,
      agentName: init.agentName,
      agentId: init.creds.agentId,
    });

    void this.startStream(watcher);
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

  /**
   * Open the watcher's connection: `all` scope, `addressed` filter.
   *
   * One connection replaces the `/notifications` poll AND the
   * `/watch/heartbeat` loop — its heartbeat is what makes the agent report
   * DORMANT (and answer "Starting a session…") rather than DISCONNECTED.
   *
   * `all` scope means the server delivers every room the agent belongs to
   * *except* those a session's connection has claimed. That is the split-brain
   * fix: "a session is already attending this room" stops being a fact
   * switchdash keeps its own copy of and starts being one the server enforces —
   * we simply never hear about a covered room.
   */
  private startStream(watcher: AgentWatcher): void {
    const { abort, creds } = watcher;
    log.debug('AutoSessionWatcher: opening watch connection', {
      localAgentId: watcher.localAgentId,
      agentId: creds.agentId,
      connectionId: watcher.connectionId,
    });

    const stream = new SwitchEventStream({
      creds: { agentId: creds.agentId, apiEndpoint: creds.apiEndpoint, token: creds.token },
      connectionId: watcher.connectionId,
      scope: 'all',
      // Only reasons to start a session: addressed messages, task events, and
      // opted-in joins. Room chatter is not one.
      filter: 'addressed',
      rooms: [],
      // This watcher exists to spawn sessions; saying so is what licenses the
      // server's "Starting a session…" reply instead of reporting the agent
      // offline.
      spawnCapable: true,
      onEvent: (event) => {
        if (event.room_id) this.handleNotification(watcher, event.room_id, event.sequence);
      },
      onGap: (info) => {
        // A gap here means we may have missed a request to start a session.
        // There is nothing to replay it from, so say so loudly rather than let
        // an unanswered mention look like an idle agent.
        log.warn('AutoSessionWatcher: gap — may have missed a spawn trigger', {
          localAgentId: watcher.localAgentId,
          agentId: creds.agentId,
          fromSequence: info.fromSequence,
          reason: info.reason,
        });
      },
      onEvicted: (reason) => {
        log.warn('AutoSessionWatcher: watch connection evicted', {
          localAgentId: watcher.localAgentId,
          agentId: creds.agentId,
          reason,
        });
      },
      log,
      signal: abort.signal,
    });
    watcher.stream = stream;
    stream.start();
  }

  /**
   * Decide whether to spawn for a notified room, with a per-room in-flight guard.
   *
   * There is no longer a "does a session already cover this room?" check here.
   * The server answers that by never delivering the event: a session's
   * connection claims the room and this `all`-scope connection goes dark on it.
   * Keeping a local copy of that fact is what let switchdash and Switch
   * disagree — a stale map meaning either a duplicate session or none at all.
   *
   * The in-flight guard is a different thing and stays: it covers the window
   * between deciding to spawn and the spawned session claiming the room, which
   * the server cannot know about.
   */
  private handleNotification(watcher: AgentWatcher, roomId: string, sequence?: number): void {
    if (watcher.inFlight.has(roomId)) {
      log.info(
        'AutoSessionWatcher: notification for room with a spawn already in flight — skipping duplicate spawn',
        { localAgentId: watcher.localAgentId, roomId }
      );
      return;
    }

    // A session of ours is already attending this room, even though the server
    // has not been told yet.
    //
    // In steady state the server answers this for us — it goes dark on a room a
    // session's connection has claimed, so we never hear about it. That leaves
    // two windows where only we can know: a session booting (the guard above),
    // and one being restored after a restart, whose connection is open but has
    // not yet claimed its room. Receiving an event for a room we are already
    // covering means we are in one of those windows, not that the room is
    // free — and spawning would give the user a second session beside a
    // perfectly good one.
    //
    // Read from the live connection map rather than the persisted one: a stale
    // row would block spawning forever, turning a duplicate session into an
    // unreachable agent, which is both worse and far harder to notice.
    const attending = switchRoomService
      .getConnections()
      .some((c) => c.roomId === roomId && c.agentId === watcher.creds.agentId);
    if (attending) {
      log.info('AutoSessionWatcher: a session of ours already attends this room', {
        event: 'auto_session_spawn_skipped_session_present',
        localAgentId: watcher.localAgentId,
        roomId,
      });
      return;
    }

    // Tell the poller where the session it is about to open should start
    // reading. We have already consumed this event — that is how we know to
    // spawn — so a session starting at head would come up having missed the
    // very message it exists to answer.
    if (sequence !== undefined) {
      switchNotificationPoller.noteSpawnTrigger(watcher.creds.agentId, sequence);
    }
    // The two halves of the hand-off are logged at both ends, so a session that
    // comes up without its triggering message can be diagnosed from the log
    // alone: this line says which event the spawn is for and where the session
    // should therefore start reading, and the poller's counterpart says where
    // it actually started.
    log.info('AutoSessionWatcher: spawning for event', {
      event: 'auto_session_spawn_trigger',
      localAgentId: watcher.localAgentId,
      agentId: watcher.creds.agentId,
      roomId,
      triggerSequence: sequence ?? null,
      sessionWillStartFrom: sequence === undefined ? 'head' : Math.max(sequence - 1, 0),
    });

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
    // Bypass permissions only if this agent is configured to. Auto-started
    // local sessions run with no operator watching, but the default is off —
    // the per-agent setting (location settings) is the source of truth.
    const agent = await getAgentById(watcher.localAgentId);
    const autoApprove = agent?.autoApprove ?? false;
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= SPAWN_MAX_ATTEMPTS; attempt += 1) {
      if (watcher.abort.signal.aborted) return;
      try {
        const result = await sessionService.createSession({
          id: randomUUID(),
          agentId: watcher.localAgentId,
          agentName: watcher.agentName,
          title: `Switch room ${roomId}`,
          // Bootstrap: tell the fresh session to join the room. Once it calls
          // connect_to_room, the connect hook starts the per-room poller, which
          // injects the message waiting in the room's event queue.
          initialPrompt: `connect to switch room ${roomId}`,
          autoApprove,
        });
        if (result.success) {
          log.info('AutoSessionWatcher: spawned session for room', {
            localAgentId: watcher.localAgentId,
            roomId,
            sessionId: result.data.session.id,
          });
          // createSession provisions the runtime inline but emits only
          // session:created — not session:provisioned. Without the latter an
          // open renderer leaves the session stuck "Setting up session…"
          // (it never reconciles to ready). provisionSession is idempotent
          // (fast-paths on the already-registered runtime) and emits the
          // provisioned event the renderer needs.
          await sessionService.provisionSession(result.data.session.id).catch((error) => {
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
