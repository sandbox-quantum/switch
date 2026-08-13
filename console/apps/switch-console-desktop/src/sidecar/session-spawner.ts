import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { quoteShellArg } from '@main/utils/shellEscape';
import { buildAgentHookEnv } from '@shared/core/pty/hookEnv';
import { asPtyProviderId, makePtyId } from '@shared/core/pty/ptyId';
import { type AgentLaunchSpec, HOME_PLACEHOLDER, materializeAgentCommand } from './agent-launch-spec';
import { atomicWriteFile } from './atomic-file';
import type { SessionSpawner, WatcherLogger } from './notification-watcher';
import { makeAgentTmuxSessionName } from './vm-tmux';

const execFileAsync = promisify(execFile);

/** The runtime slice the spawner needs to tell whether a room is already served. */
export interface RoomLivenessSource {
  hasLiveRoom(roomId: string): boolean;
}

export interface InProcessSessionSpawnerDeps {
  spec: AgentLaunchSpec;
  /** The local sidecar hook server the spawned session's hooks post back to. */
  hookPort: number;
  hookToken: string;
  /** Absolute path to the endpoint file carrying the CURRENT port/token. Hooks
   * prefer it over the baked env, so the pane follows this sidecar across a
   * restart instead of posting to the port it happened to hold at launch. */
  endpointFile: string;
  /** The multi-session runtime — a room it already serves needs no new session. */
  runtime: RoomLivenessSource;
  /**
   * Open a connection for a session about to launch and return its id, so the
   * session's tool calls land on the connection this sidecar is reading. Same
   * hand-off Switch Console does locally; without it the session opens its own and
   * the sidecar is back to inferring the room from a hook.
   */
  openConnectionFor?: (
    sessionId: string,
    providerId: string,
    roomId: string,
    startCursor?: number
  ) => string | null;
  /** The agent's Switch identity as `SWITCH_*` env, injected into every
   * auto-started session so it authenticates as this agent — a `--settings` env
   * block is not reliably propagated to the spawned MCP server (CHOO-1440). */
  switchEnv: Record<string, string>;
  /** Whether a given tmux target is currently live (poller-backed cache). */
  isPaneLive: (tmuxTarget: string) => boolean;
  log: WatcherLogger;
  /** Run a command on the VM. Injected so tests can drive it without a real host. */
  exec?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Launches a fresh agent session on the VM in response to a room notification.
 * The session is wired to THIS sidecar's own hook server (with the in-session
 * connector poll stood down), so the same agent-scoped sidecar that watches also
 * injects for the session it starts — no per-session child sidecar.
 */
export class InProcessSessionSpawner implements SessionSpawner {
  private readonly exec: (
    command: string,
    args: string[]
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Room id → the session we launched for it (its minted id + tmux target). */
  private readonly launched = new Map<string, { sessionId: string; tmuxTarget: string }>();
  /** The live launch recipe. Seeded from deps, replaceable via `setSpec` so a
   * bypass-permissions toggle takes effect without restarting the sidecar. */
  private spec: AgentLaunchSpec;

  constructor(private readonly deps: InProcessSessionSpawnerDeps) {
    this.exec = deps.exec ?? ((command, args) => execFileAsync(command, args));
    this.spec = deps.spec;
  }

  /**
   * Swap the launch recipe (the entrypoint re-reads the spec file each poll and
   * pushes it here), so a toggled setting — e.g. bypass-permissions — applies to
   * the next auto-started session without restarting the sidecar.
   */
  setSpec(spec: AgentLaunchSpec): void {
    this.spec = spec;
  }

  /**
   * Forget a launched session by its session id, so it is no longer reported as
   * pending/spawned and a fresh room notification can spawn a new one. No-op if
   * we never launched this session.
   *
   * Called both when Switch Console deletes a session and when one connects to a
   * room. The entry only covers the boot window — between launch and the first
   * `connect_to_room` — and once the runtime knows the session, its room map is
   * the accurate answer. Keeping the entry past that point makes it vouch for
   * the room the session was *started for* rather than the one it is in, so a
   * session that moves rooms leaves its old room permanently unspawnable.
   */
  drop(sessionId: string): void {
    for (const [roomId, session] of this.launched) {
      if (session.sessionId === sessionId) {
        this.launched.delete(roomId);
        this.deps.log.info('InProcessSessionSpawner: dropped launched session', {
          roomId,
          sessionId,
        });
        return;
      }
    }
  }

  /** The room a launched (not-yet-connected) session was started for, or null. */
  roomIdForSession(sessionId: string): string | null {
    for (const [roomId, session] of this.launched) {
      if (session.sessionId === sessionId) return roomId;
    }
    return null;
  }

  /** tmux targets of launched sessions, for the entrypoint's pane-liveness poll. */
  pendingTmuxTargets(): string[] {
    return [...this.launched.values()].map((s) => s.tmuxTarget);
  }

  /**
   * Sessions this watcher launched, for Switch Console to reconcile into its UI.
   * Includes the room each was started for so Switch Console can title/attach it,
   * even in the window before the session calls connect_to_room and the runtime
   * learns of it. Only live panes are reported — a launched-then-dead session
   * (crashed before connecting) is dropped so it doesn't surface as a ghost.
   */
  spawnedSessions(): Array<{ sessionId: string; roomId: string }> {
    const out: Array<{ sessionId: string; roomId: string }> = [];
    for (const [roomId, session] of this.launched) {
      if (this.deps.isPaneLive(session.tmuxTarget)) {
        out.push({ sessionId: session.sessionId, roomId });
      }
    }
    return out;
  }

  async isRoomLive(roomId: string): Promise<boolean> {
    // A session that has connected and is being injected into — the runtime knows.
    if (this.deps.runtime.hasLiveRoom(roomId)) return true;
    // Or one we launched that is still booting (its pane is up but it has not
    // called connect_to_room yet) — avoid a duplicate spawn in that window.
    const launched = this.launched.get(roomId);
    if (launched && this.deps.isPaneLive(launched.tmuxTarget)) return true;
    if (launched) this.launched.delete(roomId);
    return false;
  }

  async launch(roomId: string, startCursor?: number): Promise<void> {
    const { hookPort, hookToken, endpointFile, log } = this.deps;
    const spec = this.spec;
    const sessionId = randomUUID();
    const tmuxTarget = makeAgentTmuxSessionName(sessionId);

    // Open the session's connection before launching it: its first
    // connect_to_room arrives tagged with this id, and the server refuses a
    // call naming a connection that is not open. The room goes with it — this
    // session is being launched to answer a message in that room, so there is
    // nothing to wait to be told.
    const connectionId =
      this.deps.openConnectionFor?.(sessionId, spec.providerId, roomId, startCursor) ?? null;

    const hookEnv = {
      ...this.deps.switchEnv,
      ...buildAgentHookEnv({
        port: hookPort,
        // The spec is JSON off the host's disk, so its provider id is only a
        // string until something checks it.
        ptyId: makePtyId(asPtyProviderId(spec.providerId), sessionId),
        token: hookToken,
        endpointFile,
      }),
      ...(connectionId ? { SWITCH_CONNECTION_ID: connectionId } : {}),
    };
    const command = materializeAgentCommand(spec, {
      sessionId,
      initialPrompt: `connect to switch room ${roomId}`,
      extraEnv: hookEnv,
      homeDir: homedir(),
    });

    await this.writeLaunchFiles();
    await this.installHooks();
    await this.startDetachedTmux(tmuxTarget, spec.cwd, command.env, command.command, command.args);
    this.launched.set(roomId, { sessionId, tmuxTarget });
    log.info('InProcessSessionSpawner: launched session for room', {
      roomId,
      sessionId,
      tmuxTarget,
    });
  }

  /**
   * Write the spec's baked config files (e.g. Codex's Switch profile) under the
   * VM home before spawning. Static across spawns and safe to rewrite, so this
   * runs every launch rather than tracking whether it already ran.
   */
  private async writeLaunchFiles(): Promise<void> {
    for (const file of this.spec.launchFiles ?? []) {
      const absPath = join(homedir(), file.homeRelativePath);
      await mkdir(dirname(absPath), { recursive: true });
      // A baked file may name a sibling by absolute path (OpenCode's config
      // points at its instructions file), which Switch Console could not write
      // without knowing this VM's home.
      await atomicWriteFile(absPath, file.content.split(HOME_PLACEHOLDER).join(homedir()));
    }
  }

  /**
   * Install the provider's agent hooks on this VM before spawning, mirroring
   * what the desktop does for a session it starts itself. The pane is launched
   * with `SWITCHDASH_HOOK_*` pointing at this sidecar, but nothing posts to it
   * unless the provider's own config registers the hook commands — and without
   * them the session never reports that it has stopped, so the room it was
   * spawned to answer shows it working forever. Idempotent, so it runs per
   * launch rather than being tracked. Throws: the watcher retries a failed
   * launch and reports it in the room, which beats a session that comes up deaf.
   */
  private async installHooks(): Promise<void> {
    const providerId = this.spec.providerId;
    const plugin = getPlugin(providerId);
    const hooks = plugin.capabilities.hooks;
    if (hooks.kind === 'none') return;
    if (hooks.scope !== 'global' && hooks.scope !== 'workspace') {
      throw new Error(
        `InProcessSessionSpawner: no hook root for scope '${String(hooks.scope)}' — the session ` +
          'would run with no hooks and never report that it has stopped'
      );
    }
    const root = hooks.scope === 'global' ? homedir() : this.spec.cwd;
    const fs = createPluginFs(root);

    // Both delivery mechanisms have to be handled here, not just config files.
    // A provider whose hooks ride a dropped plugin (OpenCode) would otherwise
    // launch on a VM with nothing installed and never report that it stopped —
    // the exact failure this method exists to prevent, reached by a different
    // route. Mirrors `ensureHooksInstalled` on the desktop side.
    if (hooks.kind === 'config' && plugin.behavior.hooks) {
      // The sidecar runs on the machine the session runs on, so its own platform
      // is the target platform.
      await plugin.behavior.hooks.writeHooks(fs, [], { platform: process.platform });
    } else if (hooks.kind === 'plugin' && plugin.behavior.plugins) {
      await plugin.behavior.plugins.installPlugin(
        fs,
        hooks.scope === 'global' ? { kind: 'global' } : { kind: 'workspace', path: root }
      );
    } else {
      this.deps.log.error('InProcessSessionSpawner: provider hooks cannot be installed here', {
        providerId,
        kind: hooks.kind,
      });
      return;
    }

    this.deps.log.info('InProcessSessionSpawner: installed agent hooks', {
      providerId,
      kind: hooks.kind,
      scope: hooks.scope,
    });
  }

  /** Launch a command in a fresh detached tmux session with env set on the process. */
  private async startDetachedTmux(
    sessionName: string,
    cwd: string,
    env: Record<string, string>,
    command: string,
    args: string[]
  ): Promise<void> {
    const envPrefix = Object.entries(env)
      .map(([key, value]) => `${key}=${quoteShellArg(value)}`)
      .join(' ');
    const commandLine = [command, ...args].map(quoteShellArg).join(' ');
    const inner = `${envPrefix} exec ${commandLine}`;
    await this.exec('tmux', ['new-session', '-d', '-s', sessionName, '-c', cwd, inner]);
  }
}
