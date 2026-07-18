import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { HookEventLog, HookServer } from '@main/core/agent-hooks/hook-server';
import { readSwitchAgentCredentials } from '@main/core/switch-rooms/switch-credentials';
import { createTmuxRun } from '@main/core/switch-rooms/tmux-injection-sink';
import { type AgentLaunchSpec } from './agent-launch-spec';
import { NotificationWatcher } from './notification-watcher';
import { InProcessSessionSpawner } from './session-spawner';
import { createSidecarLogger, requireEnv } from './sidecar-logger';
import { defaultRoomConnectionFactory, SidecarRuntime } from './sidecar-runtime';
import { exactTmuxTarget, parseAgentTmuxSessionName } from './vm-tmux';

/**
 * switchdash remote runtime sidecar (CHOO-1059 → CHOO-1085).
 *
 * One agent-scoped process per remote agent, deployed to the agent's VM and kept
 * alive next to its tmux panes. It is the renderer-independent slice of
 * switchdash's Switch integration and does BOTH jobs in one process:
 *
 *  - a single agent-hook HTTP server + a multi-session runtime, so every session
 *    on the VM (the one switchdash starts over SSH and any auto-started here)
 *    stays connected to its Switch room and gets messages injected into its own
 *    tmux pane, even while the switchdash UI is closed; and
 *  - the per-agent notification watcher, which auto-starts a fresh session (wired
 *    back to this same hook server) whenever the agent is addressed in a room
 *    with no live session.
 *
 * Pure Node (no Electron, no database). The agent's Switch credentials come from
 * its `.claude/settings.local.json`; the provider-specific launch recipe for
 * auto-started sessions comes from the launch spec switchdash writes to the VM.
 * On startup it prints one JSON line to stdout — `{event:"ready",port,token}` —
 * so the launcher can point switchdash's remote sessions at this hook server.
 */

const PANE_POLL_INTERVAL_MS = 2000;
const LAUNCH_SPEC_REL_PATH = '.switchdash/agent-launch-spec.json';
const WATCH_ENABLED_REL_PATH = '.switchdash/watch-enabled';

const execFileAsync = promisify(execFile);

async function readLaunchSpec(repoDir: string): Promise<AgentLaunchSpec> {
  const specPath = path.join(repoDir, LAUNCH_SPEC_REL_PATH);
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
  return spec;
}

async function main(): Promise<void> {
  const log = createSidecarLogger(process.env.SWITCHDASH_SIDECAR_LOG_LEVEL, 'sidecar');

  const repoDir = requireEnv('SWITCHDASH_SIDECAR_REPO_DIR');
  const deeplinkScheme = process.env.SWITCHDASH_SIDECAR_DEEPLINK_SCHEME?.trim() || 'switchdash';

  const creds = await readSwitchAgentCredentials(repoDir, log);
  if (!creds) {
    throw new Error(
      `sidecar: no Switch credentials in ${repoDir}/.claude/settings.local.json — run remote setup first`
    );
  }
  const launchSpec = await readLaunchSpec(repoDir);

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
  // Every live agent conversation pane on this host, whether or not its agent
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

  const runtime = new SidecarRuntime({
    creds,
    deeplinkScheme,
    tmuxRun: createTmuxRun(log),
    isPaneLive,
    log,
    createConnection: defaultRoomConnectionFactory,
  });

  // Every raw hook the agents post is buffered so switchdash can replay it
  // through its own hook path (room/status/session) while the UI is attached;
  // the sidecar still handles it VM-locally for injection regardless.
  // Declared before the server so the /sessions provider can close over it; the
  // spawner is constructed once the server's port/token are known below.
  let spawner: InProcessSessionSpawner | null = null;

  const eventLog = new HookEventLog();
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
      // conversation id) so switchdash can reconcile watcher-spawned sessions
      // into its UI. Connected sessions win — they carry the room the agent
      // actually attends after connect_to_room.
      sessionsProvider: async () => {
        const byId = new Map<string, string | null>();
        // Every live agent pane THIS sidecar owns, room or not — so bare sessions
        // are discoverable. Scope by hasSeen: tmux names carry no repo/agent, so
        // the VM-wide enumeration must be filtered to this sidecar's sessions.
        for (const sessionId of await listAgentSessionIds()) {
          if (runtime.hasSeen(sessionId) && !byId.has(sessionId)) {
            byId.set(sessionId, null);
          }
        }
        // Room-attending / watcher-spawned sessions overwrite with their room id.
        for (const s of spawner?.spawnedSessions() ?? []) byId.set(s.sessionId, s.roomId);
        for (const s of runtime.connectedSessions()) byId.set(s.sessionId, s.roomId);
        return [...byId].map(([sessionId, roomId]) => ({ sessionId, roomId }));
      },
      // switchdash deleted a session: stop its room connection (ends the renew
      // heartbeat keeping the agent live) and forget any watcher-launched entry.
      // A deliberate delete/kill (terminated) is also broadcast to every attached
      // client via a synthetic event on the shared /events log, so they tear down
      // the session everywhere instead of leaving a ghost row that re-attaches
      // into a blank tmux session.
      disconnectHandler: (sessionId, terminated) => {
        runtime.stopSession(sessionId);
        spawner?.drop(sessionId);
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

  spawner = new InProcessSessionSpawner({
    spec: launchSpec,
    hookPort: server.getPort(),
    hookToken: server.getToken(),
    runtime,
    isPaneLive,
    log,
  });

  // The sidecar always serves session injection; the notification watcher only
  // auto-starts sessions when the agent has auto_session enabled. switchdash
  // writes `.switchdash/watch-enabled` (1/0) and we read it live, so toggling
  // auto_session takes effect without restarting the sidecar (and disrupting
  // live sessions' injection).
  let watchEnabled = false;
  const refreshWatchEnabled = async (): Promise<void> => {
    try {
      const raw = await readFile(path.join(repoDir, WATCH_ENABLED_REL_PATH), 'utf8');
      watchEnabled = raw.trim() === '1';
    } catch {
      watchEnabled = false;
    }
  };
  const watcher = new NotificationWatcher({
    creds,
    spawner,
    watchEnabled: () => watchEnabled,
    log,
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
    await Promise.all([refreshLiveness(), refreshWatchEnabled()]);
  };
  void refresh();
  const paneTimer = setInterval(() => void refresh(), PANE_POLL_INTERVAL_MS);

  // Echo the bundle hash switchdash launched us with so it can tell, on reattach,
  // whether this running process is the current bundle or a stale one to replace.
  const bundleHash = process.env.SWITCHDASH_SIDECAR_BUNDLE_HASH?.trim() || undefined;
  process.stdout.write(
    `${JSON.stringify({
      event: 'ready',
      port: server.getPort(),
      token: server.getToken(),
      hash: bundleHash,
    })}\n`
  );

  const shutdown = (): void => {
    clearInterval(paneTimer);
    watcher.stop();
    runtime.stop();
    server.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('sidecar: fatal', error);
  process.exit(1);
});
