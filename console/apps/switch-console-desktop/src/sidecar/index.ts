import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HookEventLog, HookServer } from '@main/core/agent-hooks/hook-server';
import {
  SessionStartupWatch,
  STARTUP_SIGNAL_TIMEOUT_MS,
} from '@main/core/agent-runtime/session-startup-watch';
import { agentSettingsPath } from '@main/core/agents/switch-settings-paths';
import {
  readSwitchAgentCredentials,
  readSwitchAgentCredentialsFromSettings,
} from '@main/core/switch-rooms/switch-credentials';
import { createTmuxRun } from '@main/core/switch-rooms/tmux-injection-sink';
import { type AgentLaunchSpec } from './agent-launch-spec';
import { atomicWriteFile } from './atomic-file';
import {
  NotificationWatcher,
  postRoomMessage,
  STARTUP_STALL_NOTICE,
  type WatcherLogger,
} from './notification-watcher';
import { clearStartupPromptsFor, InProcessSessionSpawner } from './session-spawner';
import { createSidecarLogger, requireEnv } from './sidecar-logger';
import {
  LEGACY_LAUNCH_SPEC_REL_PATH,
  LEGACY_WATCH_ENABLED_REL_PATH,
  sidecarEndpointRelPath,
  sidecarLaunchSpecRelPath,
  sidecarReadyRelPath,
  sidecarWatchEnabledRelPath,
} from './sidecar-paths';
import { defaultRoomConnectionFactory, SidecarRuntime } from './sidecar-runtime';
import { SidecarStateStore } from './sidecar-state';
import { SIDECAR_CONTROL, SIDECAR_VERSION } from './sidecar-version';
import { exactTmuxTarget, parseAgentTmuxSessionName } from './vm-tmux';

/**
 * Switch Console remote runtime sidecar (CHOO-1059 → CHOO-1085).
 *
 * One agent-scoped process per remote agent, deployed to the agent's VM and kept
 * alive next to its tmux panes. It is the renderer-independent slice of
 * Switch Console's Switch integration and does BOTH jobs in one process:
 *
 *  - a single agent-hook HTTP server + a multi-session runtime, so every session
 *    on the VM (the one Switch Console starts over SSH and any auto-started here)
 *    stays connected to its Switch room and gets messages injected into its own
 *    tmux pane, even while the Switch Console UI is closed; and
 *  - the per-agent notification watcher, which auto-starts a fresh session (wired
 *    back to this same hook server) whenever the agent is addressed in a room
 *    with no live session.
 *
 * Pure Node (no Electron, no database). The agent's Switch credentials come from
 * its provider-neutral per-agent file `.switch/agents/<slug>.json` (the slug is
 * passed in `SWITCHDASH_SIDECAR_AGENT_SLUG`), falling back to the legacy shared
 * `.claude/settings.local.json` for un-migrated installs (CHOO-1440); the
 * provider-specific launch recipe for auto-started sessions comes from the launch
 * spec Switch Console writes to the VM.
 * On startup it prints one JSON line to stdout — `{event:"ready",port,token}` —
 * so the launcher can point Switch Console's remote sessions at this hook server.
 */

const PANE_POLL_INTERVAL_MS = 2000;

const execFileAsync = promisify(execFile);

/**
 * sha256 of the bundle file this process was actually loaded from.
 *
 * Deriving it here rather than trusting the launcher's env closes the window
 * where a concurrent deploy replaces the bundle between the launcher hashing it
 * and node reading it — after which the sidecar would advertise one build while
 * running another, and every client would happily reattach to it forever.
 */
async function hashOwnBundle(log: WatcherLogger): Promise<string | null> {
  try {
    const self = fileURLToPath(import.meta.url);
    return createHash('sha256')
      .update(await readFile(self))
      .digest('hex');
  } catch (error) {
    log.warn('sidecar: could not hash own bundle', { error: String(error) });
    return null;
  }
}

async function readLaunchSpec(
  repoDir: string,
  specRelPath: string,
  log: { warn: (message: string, meta?: Record<string, unknown>) => void }
): Promise<AgentLaunchSpec> {
  const specPath = path.join(repoDir, specRelPath);
  let raw: string;
  try {
    raw = await readFile(specPath, 'utf8');
  } catch (error) {
    throw new Error(`sidecar: cannot read launch spec at ${specPath}: ${String(error)}`);
  }
  const spec = JSON.parse(raw) as AgentLaunchSpec;
  if (!spec.command || !Array.isArray(spec.args) || !spec.cwd || !spec.providerId) {
    throw new Error(`sidecar: launch spec at ${specPath} is missing required fields`);
  }
  // A spec written by an older Switch Console carries neither flag. Both decide
  // whether to waive a prompt on the user's behalf, so an absent one reads as
  // "do not" — and says so, because the visible effect is sessions stalling on
  // prompts this sidecar could otherwise have cleared.
  for (const key of ['autoApprove', 'autoTrustWorktrees'] as const) {
    if (typeof spec[key] !== 'boolean') {
      log.warn(`sidecar: launch spec predates ${key}; treating it as off`, { specPath });
      spec[key] = false;
    }
  }
  return spec;
}

async function main(): Promise<void> {
  const log = createSidecarLogger(process.env.SWITCHDASH_SIDECAR_LOG_LEVEL, 'sidecar');

  const repoDir = requireEnv('SWITCHDASH_SIDECAR_REPO_DIR');
  const deeplinkScheme = process.env.SWITCHDASH_SIDECAR_DEEPLINK_SCHEME?.trim() || 'switchdash';

  // Prefer the agent's provider-neutral per-agent creds file; fall back to the
  // legacy shared settings.local.json for un-migrated installs (CHOO-1440).
  const credsSlug = process.env.SWITCHDASH_SIDECAR_AGENT_SLUG?.trim();
  const creds =
    (credsSlug
      ? await readSwitchAgentCredentialsFromSettings(agentSettingsPath(repoDir, credsSlug), log)
      : null) ?? (await readSwitchAgentCredentials(repoDir, log));
  if (!creds) {
    const where = credsSlug
      ? agentSettingsPath(repoDir, credsSlug)
      : `${repoDir}/.claude/settings.local.json`;
    throw new Error(`sidecar: no Switch credentials at ${where} — run remote setup first`);
  }

  // Per-agent state paths, so multiple agents in one repo dir each drive their
  // own sidecar without clobbering each other's spec/watch flag (CHOO-1440).
  // Fall back to the legacy shared paths when launched without a slug.
  const launchSpecRel = credsSlug
    ? sidecarLaunchSpecRelPath(credsSlug)
    : LEGACY_LAUNCH_SPEC_REL_PATH;
  const watchEnabledRel = credsSlug
    ? sidecarWatchEnabledRelPath(credsSlug)
    : LEGACY_WATCH_ENABLED_REL_PATH;
  const launchSpec = await readLaunchSpec(repoDir, launchSpecRel, log);

  // Pane-liveness cache: a background poll marks each active/pending tmux target
  // live or dead so injection defers (rather than fails) when a pane is briefly
  // gone. The sinks read this synchronously.
  const liveTargets = new Set<string>();
  const isPaneLive = (target: string): boolean => liveTargets.has(target);
  const hasSession = async (target: string): Promise<boolean> => {
    try {
      await execFileAsync('tmux', ['has-session', '-t', exactTmuxTarget(target)]);
      return true;
    } catch {
      return false;
    }
  };
  // Every live agent session pane on this host, whether or not its agent
  // joined a Switch room. Lets `/sessions` surface bare sessions so another
  // client can discover and attach to them (CHOO-1181), not just room-attending
  // ones. tmux only lists live sessions, so this never reports a dead pane.
  const listAgentSessionIds = async (): Promise<string[]> => {
    try {
      const { stdout } = await execFileAsync('tmux', ['list-sessions', '-F', '#{session_name}']);
      return stdout
        .split('\n')
        .map((name) => parseAgentTmuxSessionName(name.trim()))
        .filter((id): id is string => id !== null);
    } catch {
      return []; // no tmux server / no sessions
    }
  };

  // Durable session registry. Restored entries whose pane is gone are dropped
  // here, so what survives is what is actually still running on the host.
  const stateSlug = credsSlug ?? 'default';
  const store = await SidecarStateStore.open({
    repoDir,
    slug: stateSlug,
    isPaneAlive: hasSession,
    log,
  });

  // Owned here and shared with both halves: the spawner arms it for a session
  // it starts, the runtime clears it when that session's first hook arrives and
  // consults it before typing into the pane.
  const startupWatch = new SessionStartupWatch(STARTUP_SIGNAL_TIMEOUT_MS, log);

  const runtime = new SidecarRuntime({
    creds,
    deeplinkScheme,
    tmuxRun: createTmuxRun(log),
    isPaneLive,
    log,
    createConnection: defaultRoomConnectionFactory,
    registry: store,
    startupWatch,
  });

  // A session that never reported itself up is stopped on something only a
  // human can answer, and on a VM nobody is looking at that terminal. Say so in
  // the room the session was started to answer — the same courtesy the watcher
  // already extends when a spawn fails outright, for the case where the spawn
  // succeeded and the session did not.
  //
  // The launched entry is deliberately left in place: the stuck pane is alive,
  // so dropping it would let the next message spawn a second session on top of
  // the first rather than surfacing the one that needs attention.
  startupWatch.onStall(({ sessionId, providerId }) => {
    const roomId = spawner?.roomIdForSession(sessionId);
    if (!roomId) return;
    log.error('sidecar: spawned session never reported that it started', {
      sessionId,
      providerId,
      roomId,
    });
    // The state report is what carries the deeplink and names the owner; the
    // message only says why. Both, because the report's wording is generic.
    runtime.reportStartupStalled(sessionId);
    void postRoomMessage(creds, roomId, STARTUP_STALL_NOTICE).catch((error) => {
      log.warn('sidecar: failed to post startup-stall notice', { roomId, error: String(error) });
    });
  });

  // Bring each restored session's room connection back up. The agent is still
  // sitting in its pane and still a member of the room server-side; only our
  // poll + injection loop died with the previous process, and an idle agent
  // would never post the hook that would otherwise rebuild it.
  for (const entry of store.entries()) {
    if (!entry.roomId) continue;
    liveTargets.add(entry.tmuxTarget); // seed, so injection is not deferred pre-poll
    runtime.restoreSession({
      sessionId: entry.sessionId,
      roomId: entry.roomId,
      providerId: entry.providerId,
    });
  }

  // Every raw hook the agents post is buffered so Switch Console can replay it
  // through its own hook path (room/status/session) while the UI is attached;
  // the sidecar still handles it VM-locally for injection regardless.
  // Declared before the server so the /sessions provider and disconnect handler
  // can close over them; both are constructed once the server's port/token are
  // known below.
  let spawner: InProcessSessionSpawner | null = null;
  let watcher: NotificationWatcher | null = null;

  const eventLog = new HookEventLog(undefined, store.epoch);
  const server = new HookServer(log);
  await server.start(
    async (raw) => {
      log.info('sidecar: received hook from agent — buffering for relay', {
        type: raw.type,
        ptyId: raw.ptyId,
      });
      eventLog.append(raw);
      await runtime.handleHook(raw);
    },
    {
      eventLog,
      // Snapshot of live VM sessions (connected + just-launched, deduped by
      // session id) so Switch Console can reconcile watcher-spawned sessions
      // into its UI. Connected sessions win — they carry the room the agent
      // actually attends after connect_to_room.
      sessionsProvider: async () => {
        const byId = new Map<string, string | null>();
        // Every live agent pane THIS sidecar owns, room or not — so bare sessions
        // are discoverable. Scope by hasSeen: tmux names carry no repo/agent, so
        // the VM-wide enumeration must be filtered to this sidecar's sessions.
        // That ownership is durable, so a pane restored across a restart is
        // reported immediately rather than only once its agent next speaks —
        // otherwise clients read the gap as "deleted" and prune a live session.
        for (const sessionId of await listAgentSessionIds()) {
          if (runtime.hasSeen(sessionId) && !byId.has(sessionId)) {
            byId.set(sessionId, store.roomIdFor(sessionId));
          }
        }
        // Room-attending / watcher-spawned sessions overwrite with their room id.
        for (const s of spawner?.spawnedSessions() ?? []) byId.set(s.sessionId, s.roomId);
        for (const s of runtime.connectedSessions()) byId.set(s.sessionId, s.roomId);
        return [...byId].map(([sessionId, roomId]) => ({ sessionId, roomId }));
      },
      // Switch Console is about to start a session over SSH: open its room
      // connection here first and hand back the id, so the session's tool calls
      // land on the connection this sidecar reads and injects from. Without it
      // the session holds a connection nobody on the VM is listening to, and
      // never learns which room it is in. No room yet — the agent's
      // connect_to_room claims one and the server reports it back.
      connectionHandler: (sessionId, providerId) =>
        runtime.ensureForSession(sessionId, providerId, null),
      // Switch Console deleted a session: stop its room connection (ends the renew
      // heartbeat keeping the agent live) and forget any watcher-launched entry.
      // A deliberate delete/kill (terminated) is also broadcast to every attached
      // client via a synthetic event on the shared /events log, so they tear down
      // the session everywhere instead of leaving a ghost row that re-attaches
      // into a blank tmux session.
      disconnectHandler: (sessionId, terminated) => {
        // Resolve the session's room before teardown, then clear the watcher's
        // in-flight guard for it — otherwise a delete during the boot window
        // (before the session connects, so the connect hand-off never fired)
        // leaves the room gated for up to INFLIGHT_TTL_MS and a near-immediate
        // re-address is silently dropped (CHOO-1664).
        const roomId = runtime.roomIdForSession(sessionId) ?? spawner?.roomIdForSession(sessionId);
        runtime.stopSession(sessionId);
        spawner?.drop(sessionId);
        if (roomId) watcher?.clearRoom(roomId);
        if (terminated) {
          eventLog.append({
            ptyId: '',
            type: 'session-terminated',
            body: JSON.stringify({ sessionId }),
          });
        }
      },
    }
  );

  // Publish the live endpoint before anything can be spawned against it. Panes
  // resolve the port/token from this file at hook time rather than from the env
  // they were launched with, so sessions started by a previous incarnation of
  // this sidecar keep reaching us across a restart, upgrade, or token rotation.
  const endpointFile = path.join(repoDir, sidecarEndpointRelPath(credsSlug ?? 'default'));
  await mkdir(path.dirname(endpointFile), { recursive: true });
  await atomicWriteFile(endpointFile, `${server.getPort()}\n${server.getToken()}\n`);

  spawner = new InProcessSessionSpawner({
    spec: launchSpec,
    hookPort: server.getPort(),
    hookToken: server.getToken(),
    endpointFile,
    runtime,
    openConnectionFor: (sessionId, providerId, roomId, startCursor) =>
      runtime.ensureForSession(sessionId, providerId, roomId, startCursor),
    switchEnv: {
      SWITCH_API_ENDPOINT: creds.apiEndpoint,
      SWITCH_API_TOKEN: creds.token,
      SWITCH_AGENT_ID: creds.agentId,
    },
    isPaneLive,
    log,
    startupWatch,
  });

  // The sidecar always serves session injection; the notification watcher only
  // auto-starts sessions when the agent has auto_session enabled. Switch Console
  // writes `.switchdash/watch-enabled` (1/0) and we read it live, so toggling
  // auto_session takes effect without restarting the sidecar (and disrupting
  // live sessions' injection).
  let watchEnabled = false;
  const refreshWatchEnabled = async (): Promise<void> => {
    try {
      const raw = await readFile(path.join(repoDir, watchEnabledRel), 'utf8');
      watchEnabled = raw.trim() === '1';
    } catch {
      watchEnabled = false;
    }
  };

  // Re-read the launch spec each poll and push it to the spawner, so a toggled
  // setting (e.g. bypass-permissions, CHOO-1664) applies to the next auto-started
  // session without restarting the sidecar — mirroring `watch-enabled`. A read or
  // parse failure keeps the last good spec rather than crashing the poll.
  let lastSpecJson = JSON.stringify(launchSpec);
  const refreshLaunchSpec = async (): Promise<void> => {
    let spec: AgentLaunchSpec;
    try {
      spec = await readLaunchSpec(repoDir, launchSpecRel, log);
    } catch (error) {
      log.warn('sidecar: failed to re-read launch spec; keeping current', {
        error: String(error),
      });
      return;
    }
    const json = JSON.stringify(spec);
    if (json === lastSpecJson) return;
    lastSpecJson = json;
    spawner?.setSpec(spec);
    log.info('sidecar: launch spec changed — applied to spawner');
  };
  watcher = new NotificationWatcher({
    creds,
    spawner,
    watchEnabled: () => watchEnabled,
    log,
  });
  // Hand the per-room spawn guard off to the live-room check the moment a session
  // connects — so a session torn down shortly after connecting does not leave the
  // room gated until INFLIGHT_TTL_MS (mirrors the local AutoSessionWatcher).
  // Both spawn guards end here. The launched entry in particular must go even
  // when the session connects to a DIFFERENT room than it was started for:
  // keyed by the room it was launched for, it would otherwise keep vouching for
  // a room the session has left, and pings there would never spawn again.
  runtime.onRoomConnected((roomId, sessionId) => {
    watcher?.clearRoom(roomId);
    spawner?.drop(sessionId);
  });
  watcher.start();

  const refreshLiveness = async (): Promise<void> => {
    const targets = new Set([
      ...runtime.activeTmuxTargets(),
      ...(spawner?.pendingTmuxTargets() ?? []),
    ]);
    await Promise.all(
      [...targets].map(async (t) => {
        if (await hasSession(t)) liveTargets.add(t);
        else liveTargets.delete(t);
      })
    );
    for (const t of [...liveTargets]) if (!targets.has(t)) liveTargets.delete(t);
  };
  const refresh = async (): Promise<void> => {
    await Promise.all([refreshLiveness(), refreshWatchEnabled(), refreshLaunchSpec()]);
  };
  void refresh();
  const paneTimer = setInterval(() => void refresh(), PANE_POLL_INTERVAL_MS);

  // Hash our OWN bytes rather than echoing the hash we were launched with: the
  // launcher can skip an upload it believes is redundant and be wrong, and a
  // sidecar that advertises a build it is not running is undetectable.
  // Before this sidecar reports ready — which is the signal Switch Console
  // waits on before opening a session's pane over SSH — clear the CLI prompts
  // that would stop that pane before it starts. A desktop-started session never
  // passes through the spawner, so this is the only point that covers it.
  await clearStartupPromptsFor(launchSpec, log);

  const bundleHash = await hashOwnBundle(log);
  const readyLine = `${JSON.stringify({
    event: 'ready',
    port: server.getPort(),
    token: server.getToken(),
    hash: bundleHash,
    version: SIDECAR_VERSION,
    // Which Switch Console install deployed this process. Echoed from the env we
    // were launched with — unlike the hash above, which we recompute because the
    // launcher's claim about our BYTES can go stale under a concurrent deploy.
    // Nothing on the host can derive this: who started us is precisely what the
    // launcher knows and we do not. Omitted when launched without one, and a
    // reader must take its absence as unknown rather than as its own.
    deployer: process.env.SWITCHDASH_SIDECAR_DEPLOYER_ID?.trim() || null,
    // What this sidecar speaks, declared in the file the client already reads
    // (CHOO-1865). The version above says only which release this is;
    // compatibility is this. A sidecar deployed before it existed omits the
    // field, and the client must read that as unknown rather than as agreement.
    contract: { speaks: SIDECAR_CONTROL.speaks, accepts: SIDECAR_CONTROL.accepts },
    epoch: store.epoch,
    pid: process.pid,
  })}\n`;
  // Write the ready file ourselves, atomically, instead of letting the shell
  // truncate it on redirect. It is the only record of the running sidecar's
  // endpoint, so a reader arriving mid-startup must see the previous complete
  // line or the new one — never an empty file, which reads as "no sidecar" and
  // sends that client off to kill and relaunch a healthy process.
  await atomicWriteFile(path.join(repoDir, sidecarReadyRelPath(stateSlug)), readyLine);
  process.stdout.write(readyLine);

  const shutdown = (): void => {
    clearInterval(paneTimer);
    watcher?.stop();
    runtime.stop();
    server.stop();
    // Flush any debounced state change before exiting, so a clean restart (the
    // upgrade path) resumes from the sessions we actually had.
    void store.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('sidecar: fatal', error);
  process.exit(1);
});
