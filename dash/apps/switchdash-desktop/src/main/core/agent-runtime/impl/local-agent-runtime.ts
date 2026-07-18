import { homedir } from 'node:os';
import { agentHookService } from '@main/core/agent-hooks/agent-hook-service';
import { ensureHooksInstalled } from '@main/core/agent-hooks/hook-config-service';
import { dirTrustService } from '@main/core/agent-hooks/dir-trust-service';
import { AgentRuntimeSupervisor } from '@main/core/agent-runtime/agent-runtime-supervisor';
import { resolveAgentSessionCommandArgs } from '@main/core/agent-runtime/resolve-agent-session-command';
import type { AgentRuntimeProvider } from '@main/core/agent-runtime/types';
import { localDependencyManager } from '@main/core/dependencies/dependency-managers';
import { hostDependencyStore } from '@main/core/dependencies/host-dependency-store';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { spawnLocalPty } from '@main/core/pty/local-pty';
import type { Pty } from '@main/core/pty/pty';
import { buildAgentEnv } from '@main/core/pty/pty-env';
import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import { logLocalPtySpawnWarnings, resolveLocalPtySpawn } from '@main/core/pty/pty-spawn-platform';
import { getTerminalColorEnv } from '@main/core/pty/terminal-color-scheme';
import { killTmuxSession, makeAgentTmuxSessionName } from '@main/core/pty/tmux-session-name';
import { sessionHooks } from '@main/core/sessions/session-hooks';
import { providerOverrideSettings } from '@main/core/settings/provider-settings-service';
import { switchNotificationPoller } from '@main/core/switch-rooms/switch-notification-poller';
import { switchRoomService } from '@main/core/switch-rooms/switch-room-service';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { agentSessionExitedChannel } from '@shared/core/providers/agentEvents';
import { makePtyId } from '@shared/core/pty/ptyId';
import { makeAgentPtySessionId } from '@shared/core/pty/ptySessionId';
import type { Session } from '@shared/core/sessions/sessions';
import { scheduleInitialPromptInjection } from './keystroke-injection';
import { resolveAgentExecutable } from './resolve-agent-executable';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const RESPAWN_DELAY_MS = 500;

function parseExtraArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.trim().split(/\s+/);
}

export class LocalAgentRuntime implements AgentRuntimeProvider {
  private pty: Pty | null = null;
  private known = false;
  private supervisor = new AgentRuntimeSupervisor();
  private readonly locationId: string;
  private readonly sessionPath: string;
  private readonly sessionId: string;
  private readonly tmux: boolean;
  private readonly shellSetup?: string;
  private readonly shellProfile: ResolvedShellProfile;
  private readonly ctx: IExecutionContext;
  private readonly sessionEnvVars: Record<string, string>;
  constructor({
    locationId,
    sessionPath,
    sessionId,
    tmux = false,
    shellSetup,
    shellProfile,
    ctx,
    sessionEnvVars = {},
  }: {
    locationId: string;
    sessionPath: string;
    sessionId: string;
    tmux?: boolean;
    shellSetup?: string;
    shellProfile: ResolvedShellProfile;
    ctx: IExecutionContext;
    sessionEnvVars?: Record<string, string>;
  }) {
    this.locationId = locationId;
    this.sessionPath = sessionPath;
    this.sessionId = sessionId;
    this.tmux = tmux;
    this.shellSetup = shellSetup;
    this.shellProfile = shellProfile;
    this.ctx = ctx;
    this.sessionEnvVars = sessionEnvVars;
  }

  /** The registry key of this session's agent PTY (session id == session id). */
  private get ptySessionId(): string {
    return makeAgentPtySessionId(this.locationId, this.sessionId);
  }

  async start(
    session: Session,
    initialSize: { cols: number; rows: number } = {
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    },
    isResuming: boolean = false,
    initialPrompt?: string
  ): Promise<void> {
    return this.startInternal(session, initialSize, isResuming, initialPrompt, false);
  }

  private async startInternal(
    session: Session,
    initialSize: { cols: number; rows: number },
    isResuming: boolean,
    initialPrompt: string | undefined,
    requireDesired: boolean
  ): Promise<void> {
    const ptySessionId = this.ptySessionId;
    this.known = true;

    const spawnSize = ptySessionRegistry.getLastSize(ptySessionId) ?? initialSize;
    const spawnToken = this.supervisor.beginStart({
      requireDesired,
      mode: isResuming ? 'resume' : 'fresh',
    });
    if (!spawnToken) return;

    try {
      await dirTrustService.maybeAutoTrustLocal({
        providerId: session.providerId,
        cwd: this.sessionPath,
        homedir: homedir(),
        force: session.autoApprove === true,
      });
      await ensureHooksInstalled({
        providerId: session.providerId,
        sessionPath: this.sessionPath,
      });

      const providerConfig = await providerOverrideSettings.getItem(session.providerId);
      const agentSession = resolveAgentSessionCommandArgs(session, isResuming);
      const plugin = getPlugin(session.providerId);
      const subagentsBehavior = plugin.behavior.subagents;

      const binaryName = plugin.capabilities.hostDependency.binaryNames[0] ?? session.providerId;
      const cachedStatePath = localDependencyManager.get(session.providerId as never)?.path;
      const executableCli = await resolveAgentExecutable({
        providerId: session.providerId,
        binaryName,
        ctx: this.ctx,
        hostDependencyStore,
        cachedStatePath,
      });

      const extraArgs = [
        ...parseExtraArgs(providerConfig?.extraArgs),
        ...(session.subagentName && subagentsBehavior
          ? subagentsBehavior.launchArgs(this.sessionPath, session.subagentName)
          : []),
      ];
      const agentCommand = plugin.behavior.prompt!.buildCommand({
        cli: executableCli,
        extraArgs,
        autoApprove: session.autoApprove ?? false,
        initialPrompt: agentSession.isResuming ? undefined : initialPrompt,
        sessionId: agentSession.sessionId,
        providerSessionId: session.providerSessionId ?? undefined,
        isResuming: agentSession.isResuming,
        model: '',
      });

      const customEnv = providerConfig?.env ?? {};
      const providerVars: Record<string, string> = { ...agentCommand.env, ...customEnv };

      const tmuxSessionName = this.tmux ? makeAgentTmuxSessionName(this.sessionId) : undefined;

      const resolved = resolveLocalPtySpawn({
        platform: process.platform,
        env: process.env,
        intent: {
          kind: 'run-command',
          cwd: this.sessionPath,
          command: { kind: 'argv', command: agentCommand.command, args: agentCommand.args },
          shellProfile: this.shellProfile,
          shellSetup: this.shellSetup,
          tmuxSessionName,
        },
      });

      logLocalPtySpawnWarnings('LocalAgentRuntime', resolved.warnings, {
        sessionId: ptySessionId,
      });

      const ptyId = makePtyId(session.providerId, this.sessionId);
      const port = agentHookService.getPort();
      const token = agentHookService.getToken();
      const colorEnv = await getTerminalColorEnv();
      // A subagent session must talk to Switch as the subagent, not the parent
      // whose creds live in `.claude/settings.local.json`. Real env vars outrank
      // every settings file and reach the spawned MCP server, so inject them
      // last (highest precedence).
      const subagentVars =
        session.subagentName && subagentsBehavior
          ? await subagentsBehavior.readLaunchEnv(
              createPluginFs(this.sessionPath),
              session.subagentName
            )
          : {};
      const pty = spawnLocalPty({
        id: ptySessionId,
        command: resolved.command,
        args: resolved.args,
        cwd: resolved.cwd,
        env: {
          ...buildAgentEnv({
            hook: port > 0 ? { port, ptyId, token } : undefined,
            providerVars,
            shellProfile: this.shellProfile,
          }),
          ...colorEnv,
          ...this.sessionEnvVars,
          ...subagentVars,
        },
        cols: spawnSize.cols,
        rows: spawnSize.rows,
      });

      pty.onExit((info) => {
        const decision = this.supervisor.handleExit(pty);
        if (decision.kind === 'stale') return;
        const replacementSize = ptySessionRegistry.getLastSize(ptySessionId) ?? spawnSize;

        ptySessionRegistry.unregister(ptySessionId, { pty, exitInfo: info });
        this.pty = null;
        if (decision.kind === 'stopped') return;

        events.emit(agentSessionExitedChannel, { sessionId: this.sessionId });
        // In-process counterpart for main-process consumers — `events` only
        // reaches the renderer (see session-hooks).
        sessionHooks._emit('session:agent-exited', { sessionId: this.sessionId });

        if (this.tmux) {
          return;
        }

        if (this.supervisor.isDesired()) {
          this.scheduleReplacement({
            session,
            initialSize: replacementSize,
            isResuming: decision.kind === 'respawnResume',
          });
        }
      });

      if (!this.supervisor.acceptSpawn(spawnToken, pty)) {
        try {
          pty.kill();
        } catch {}
        if (ptySessionRegistry.get(ptySessionId) === pty) {
          ptySessionRegistry.unregister(ptySessionId);
        }
        return;
      }

      ptySessionRegistry.register(ptySessionId, pty, {
        metadata: {
          providerId: session.providerId,
          title: session.title,
        },
      });
      this.pty = pty;
      scheduleInitialPromptInjection({
        pty,
        session,
        initialPrompt,
        isResuming: agentSession.isResuming,
      });
      // If this session was connected to a Switch room before an app restart,
      // resume polling that room — the connect_to_room hook only fires on a
      // live tool call, so a resumed session would otherwise go silent.
      void switchRoomService
        .restorePoller({
          sessionId: this.sessionId,
          providerId: session.providerId,
          ptyId,
        })
        .catch((error) => {
          log.warn('LocalAgentRuntime: failed to restore Switch room poller', {
            sessionId: this.sessionId,
            error: String(error),
          });
        });
    } catch (error) {
      this.supervisor.failSpawn(spawnToken);
      throw error;
    }
  }

  private detachPty(): void {
    const pty = this.supervisor.stop() ?? this.pty;
    this.pty = null;
    ptySessionRegistry.unregister(this.ptySessionId);
    if (pty) {
      try {
        pty.kill();
      } catch (e) {
        log.warn('LocalAgentRuntime: error killing PTY', {
          sessionId: this.sessionId,
          error: String(e),
        });
      }
    }
  }

  async dehydrate(): Promise<void> {
    this.detachPty();
    switchNotificationPoller.disconnect(this.sessionId);
    switchRoomService.clearSession(this.sessionId);
    if (!this.tmux) {
      this.known = false;
      this.supervisor.forget();
    }
  }

  async stop(): Promise<void> {
    switchNotificationPoller.disconnect(this.sessionId);
    switchRoomService.clearSession(this.sessionId);
    this.known = false;
    this.detachPty();
    if (this.tmux) {
      await killTmuxSession(this.ctx, makeAgentTmuxSessionName(this.sessionId));
    }
    this.supervisor.forget();
  }

  async destroy(): Promise<void> {
    const wasKnown = this.known;
    await this.detach();
    if (this.tmux && wasKnown) {
      await killTmuxSession(this.ctx, makeAgentTmuxSessionName(this.sessionId));
    }
    this.supervisor.forget();
    this.known = false;
  }

  async detach(): Promise<void> {
    if (this.pty) {
      const pty = this.pty;
      this.supervisor.stop();
      switchNotificationPoller.disconnect(this.sessionId);
      switchRoomService.clearSession(this.sessionId);
      try {
        pty.kill();
      } catch {}
      ptySessionRegistry.unregister(this.ptySessionId);
      this.pty = null;
    }
  }

  private scheduleReplacement({
    session,
    initialSize,
    isResuming,
  }: {
    session: Session;
    initialSize: { cols: number; rows: number };
    isResuming: boolean;
  }): void {
    setTimeout(() => {
      this.startInternal(session, initialSize, isResuming, undefined, true).catch((e) => {
        log.error('LocalAgentRuntime: replacement failed', {
          sessionId: this.sessionId,
          error: String(e),
        });
      });
    }, RESPAWN_DELAY_MS);
  }
}
