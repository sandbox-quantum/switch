import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { quoteShellArg } from '@main/utils/shellEscape';
import { makePtyId } from '@shared/core/pty/ptyId';
import { type AgentLaunchSpec, materializeAgentCommand } from './agent-launch-spec';
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
  /** The multi-session runtime — a room it already serves needs no new session. */
  runtime: RoomLivenessSource;
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

  constructor(private readonly deps: InProcessSessionSpawnerDeps) {
    this.exec = deps.exec ?? ((command, args) => execFileAsync(command, args));
  }

  /**
   * Forget a launched session by its session id (switchdash deleted it), so
   * it is no longer reported as pending/spawned and a fresh room notification can
   * spawn a new one. No-op if we never launched this session.
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

  /** tmux targets of launched sessions, for the entrypoint's pane-liveness poll. */
  pendingTmuxTargets(): string[] {
    return [...this.launched.values()].map((s) => s.tmuxTarget);
  }

  /**
   * Sessions this watcher launched, for switchdash to reconcile into its UI.
   * Includes the room each was started for so switchdash can title/attach it,
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

  async launch(roomId: string): Promise<void> {
    const { spec, hookPort, hookToken, log } = this.deps;
    const sessionId = randomUUID();
    const tmuxTarget = makeAgentTmuxSessionName(sessionId);

    const hookEnv = {
      SWITCHDASH_HOOK_PORT: String(hookPort),
      SWITCHDASH_PTY_ID: makePtyId(spec.providerId, sessionId),
      SWITCHDASH_HOOK_TOKEN: hookToken,
      SWITCH_CHANNEL_DISABLE_POLL: '1',
    };
    const command = materializeAgentCommand(spec, {
      sessionId,
      initialPrompt: `connect to switch room ${roomId}`,
      extraEnv: hookEnv,
    });

    await this.startDetachedTmux(tmuxTarget, spec.cwd, command.env, command.command, command.args);
    this.launched.set(roomId, { sessionId, tmuxTarget });
    log.info('InProcessSessionSpawner: launched session for room', {
      roomId,
      sessionId,
      tmuxTarget,
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
