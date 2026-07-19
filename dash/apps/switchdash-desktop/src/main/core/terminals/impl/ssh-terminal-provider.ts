import type { IExecutionContext } from '@main/core/execution-context/types';
import { isUnexpectedPtyExit } from '@main/core/pty/exit-classification';
import type { Pty } from '@main/core/pty/pty';
import { ptySessionRegistry, type PtySessionMetadata } from '@main/core/pty/pty-session-registry';
import { resolveSshCommand } from '@main/core/pty/spawn-utils';
import { openSsh2Pty } from '@main/core/pty/ssh2-pty';
import { getTerminalColorEnv } from '@main/core/pty/terminal-color-scheme';
import { killTmuxSession, makeTmuxSessionName } from '@main/core/pty/tmux-session-name';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import { resolveTerminalShellWithSystemFallback } from '@main/core/terminal-shell/resolver';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';
import {
  type LifecycleScriptSpawnRequest,
  type TerminalProvider,
} from '@main/core/terminals/terminal-provider';
import { log } from '@main/lib/logger';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';
import type { GeneralSessionConfig } from '@shared/core/terminals/general-session';
import type { TerminalShellId } from '@shared/core/terminals/terminal-settings';
import type { Terminal } from '@shared/core/terminals/terminals';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_RESPAWNS = 2;

type SpawnPolicy = {
  respawnOnExit: boolean;
  preserveBufferOnExit: boolean;
};

export class SshTerminalProvider implements TerminalProvider {
  readonly kind = 'ssh' as const;

  private sessions = new Map<string, Pty>();
  private knownSessionIds = new Set<string>();
  private shellProfiles = new Map<string, ResolvedShellProfile>();
  private respawnCounts = new Map<string, number>();
  private readonly scopeId: string;
  private readonly sessionPath: string;
  private readonly sessionEnvVars: Record<string, string>;
  private readonly tmux: boolean;
  private readonly shellSetup?: string;
  private readonly ctx: IExecutionContext;
  private readonly proxy: SshClientProxy;

  constructor({
    scopeId,
    sessionPath,
    sessionEnvVars = {},
    tmux = false,
    shellSetup,
    ctx,
    proxy,
  }: {
    scopeId: string;
    sessionPath: string;
    sessionEnvVars?: Record<string, string>;
    tmux?: boolean;
    shellSetup?: string;
    ctx: IExecutionContext;
    proxy: SshClientProxy;
  }) {
    this.scopeId = scopeId;
    this.sessionPath = sessionPath;
    this.sessionEnvVars = sessionEnvVars;
    this.tmux = tmux;
    this.shellSetup = shellSetup;
    this.ctx = ctx;
    this.proxy = proxy;
  }

  async spawnLifecycleScript({
    terminal,
    command,
    shellSetup,
    initialSize = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
    respawnOnExit = false,
    preserveBufferOnExit = true,
  }: LifecycleScriptSpawnRequest): Promise<void> {
    return this.spawnWithPolicy(
      terminal,
      initialSize,
      command === undefined ? undefined : { command, args: [] },
      shellSetup,
      'system',
      { isRemote: true },
      {
        respawnOnExit,
        preserveBufferOnExit,
      }
    );
  }

  private async spawnWithPolicy(
    terminal: Terminal,
    initialSize: { cols: number; rows: number },
    command: { command: string; args: string[] } | undefined,
    shellSetup: string | undefined,
    shellIntent: TerminalShellId,
    metadata: PtySessionMetadata | undefined,
    policy: SpawnPolicy
  ): Promise<void> {
    const sessionId = makePtySessionId(terminal.projectId, terminal.sessionId, terminal.id);
    this.knownSessionIds.add(sessionId);
    if (this.sessions.has(sessionId)) return;

    const cfg: GeneralSessionConfig = {
      sessionId: this.scopeId,
      cwd: this.sessionPath,
      shellSetup: shellSetup ?? this.shellSetup,
      tmuxSessionName: this.tmux ? makeTmuxSessionName(sessionId) : undefined,
      command: command?.command,
      args: command?.args,
    };

    const [shellProfile, colorEnv] = await Promise.all([
      this.getSessionShellProfile(sessionId, shellIntent),
      getTerminalColorEnv(),
    ]);
    const sshCommand = resolveSshCommand(
      'general',
      cfg,
      { ...colorEnv, ...this.sessionEnvVars },
      shellProfile
    );

    const result = await openSsh2Pty(this.proxy, {
      id: sessionId,
      command: sshCommand,
      cols: initialSize.cols,
      rows: initialSize.rows,
    });

    if (!result.success) {
      log.error('SshTerminalProvider: failed to open SSH channel', {
        sessionId,
        error: result.error.message,
      });
      throw new Error(result.error.message);
    }
    const pty = result.data;

    pty.onExit((info) => {
      // A superseded pty (e.g. one discarded during rehydrate) can fire its
      // channel `close` late. Ignore it so it does not tear down the session
      // that has already replaced it in the map.
      if (this.sessions.get(sessionId) !== pty) return;
      const { exitCode, signal } = info;
      const shouldRespawn =
        policy.respawnOnExit &&
        this.sessions.has(sessionId) &&
        isUnexpectedPtyExit({ exitCode, signal });
      this.sessions.delete(sessionId);
      if (!policy.preserveBufferOnExit) {
        ptySessionRegistry.unregister(sessionId, { pty, exitInfo: info });
      }
      if (shouldRespawn && !this.tmux) {
        const count = (this.respawnCounts.get(sessionId) ?? 0) + 1;
        this.respawnCounts.set(sessionId, count);

        if (count > MAX_RESPAWNS) {
          log.error('SshTerminalProvider: respawn limit reached, giving up', {
            terminalId: terminal.id,
            respawnCount: count,
          });
          this.respawnCounts.delete(sessionId);
          this.shellProfiles.delete(sessionId);
          return;
        }

        setTimeout(() => {
          this.spawnWithPolicy(
            terminal,
            initialSize,
            command,
            shellSetup,
            shellIntent,
            metadata,
            policy
          ).catch((e) => {
            log.error('SshTerminalProvider: respawn failed', {
              terminalId: terminal.id,
              error: String(e),
            });
          });
        }, 500);
      } else {
        this.shellProfiles.delete(sessionId);
      }
    });

    ptySessionRegistry.register(sessionId, pty, {
      preserveBufferOnExit: policy.preserveBufferOnExit,
      metadata,
    });
    this.sessions.set(sessionId, pty);
  }

  private async getSessionShellProfile(
    sessionId: string,
    shellIntent: TerminalShellId
  ): Promise<ResolvedShellProfile> {
    const existing = this.shellProfiles.get(sessionId);
    if (existing) return existing;
    const remoteProfile = await this.proxy.getRemoteShellProfile();
    const profile = await resolveTerminalShellWithSystemFallback({
      intent: shellIntent,
      target: { kind: 'ssh', proxy: this.proxy, profile: remoteProfile },
      onFallback: () => {
        log.warn('SshTerminalProvider: stored shell unavailable, using system shell', {
          shell: shellIntent,
          sessionId,
        });
      },
    });
    this.shellProfiles.set(sessionId, profile);
    return profile;
  }

  async destroyAll(): Promise<void> {
    const sessionIds = Array.from(this.knownSessionIds);
    await this.detachAll();
    if (this.tmux) {
      await Promise.all(sessionIds.map((id) => killTmuxSession(this.ctx, makeTmuxSessionName(id))));
    }
    this.knownSessionIds.clear();
    this.shellProfiles.clear();
  }

  private async detachAll(): Promise<void> {
    for (const [sessionId, pty] of this.sessions) {
      try {
        pty.kill();
      } catch {}
      ptySessionRegistry.unregister(sessionId);
      this.shellProfiles.delete(sessionId);
    }
    this.sessions.clear();
  }
}
