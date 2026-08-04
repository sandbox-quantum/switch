import { homedir } from 'node:os';
import { agentHookService } from '@main/core/agent-hooks/agent-hook-service';
import { dirTrustService } from '@main/core/agent-hooks/dir-trust-service';
import { ensureHooksInstalled } from '@main/core/agent-hooks/hook-config-service';
import { AgentRuntimeSupervisor } from '@main/core/agent-runtime/agent-runtime-supervisor';
import { resolveAgentSessionCommandArgs } from '@main/core/agent-runtime/resolve-agent-session-command';
import { prepareSwitchMcpLaunch } from '@main/core/agent-runtime/switch-mcp-launch-args';
import type { AgentRuntimeProvider } from '@main/core/agent-runtime/types';
import { agentCredsSlug } from '@main/core/agents/agent-creds-slug';
import { getAgentById } from '@main/core/agents/getAgentById';
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
import { npmRegistryAuthEnv } from '@main/core/switch-rooms/npm-registry-auth';
import { readAgentSwitchEnvFromFs } from '@main/core/switch-rooms/switch-credentials';
import { switchNotificationPoller } from '@main/core/switch-rooms/switch-notification-poller';
import { switchRoomService } from '@main/core/switch-rooms/switch-room-service';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';
import { events } from '@main/lib/events';
import { runWithLogContext } from '@main/lib/log-context';
import { log } from '@main/lib/logger';
import { toSwitchSpecialization } from '@shared/core/agents/agent-provider-config';
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
    // Establishes the scope the PTY spawn and everything else below inherits,
    // so those lines name their session without being handed its id.
    return runWithLogContext(
      {
        component: 'local-agent-runtime',
        sessionId: this.sessionId,
        agentId: session.agentId,
        agentName: session.agentName ?? undefined,
      },
      () => this.startInternal(session, initialSize, isResuming, initialPrompt, false)
    );
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
      const repoAgents = plugin.behavior.repoAgents;

      const binaryName = plugin.capabilities.hostDependency.binaryNames[0] ?? session.providerId;
      const cachedStatePath = localDependencyManager.get(session.providerId as never)?.path;
      const executableCli = await resolveAgentExecutable({
        providerId: session.providerId,
        binaryName,
        ctx: this.ctx,
        hostDependencyStore,
        cachedStatePath,
      });

      // A session talks to Switch as its own agent, not whatever identity happens
      // to sit in `.claude/settings.local.json`. Real env vars outrank every
      // settings file and reach the spawned MCP server, so inject the agent's
      // identity last (highest precedence): a subagent from its definition creds,
      // and a plain agent from its provider-neutral `.switch/agents/<slug>.json`
      // (empty when absent — the session then falls back to settings.local.json,
      // which Claude reads natively).
      // Resolved before the command is built because a provider that registers
      // the Switch server at launch keys it on this identity (see below).
      const workspaceFs = createPluginFs(this.sessionPath);
      const identityVars =
        session.agentName && repoAgents
          ? await repoAgents.readLaunchEnv(workspaceFs, session.agentName)
          : await readAgentSwitchEnvFromFs(workspaceFs, agentCredsSlug(session), log);

      // Register the Switch MCP server for providers that cannot resolve it from
      // a bundled config (Codex): writes a per-agent profile under `~/.codex` and
      // returns `--profile <slug>`, folding in the agent's per-agent model /
      // effort / instructions. A no-op for Claude, whose plugin expands its own
      // `.mcp.json`.
      const agentRecord = await getAgentById(session.agentId);
      const switchMcpArgs = await prepareSwitchMcpLaunch(plugin, {
        homeFs: createPluginFs(homedir()),
        slug: agentCredsSlug(session),
        workingDir: this.sessionPath,
        hasSwitchIdentity: !!identityVars.SWITCH_API_ENDPOINT,
        specialization: toSwitchSpecialization(agentRecord?.providerConfig),
      });

      const agentCommand = plugin.behavior.prompt!.buildCommand({
        cli: executableCli,
        extraArgs: parseExtraArgs(providerConfig?.extraArgs),
        // The provider owns how to run as the named agent (CHOO-1440), and how to
        // receive a per-session Switch MCP server when it cannot read one from a
        // config file.
        agentArgs: [
          ...(session.agentName && repoAgents
            ? repoAgents.launchArgs(this.sessionPath, session.agentName)
            : []),
          ...switchMcpArgs,
        ],
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

      const ptyId = makePtyId(session.providerId, this.sessionId);
      const port = agentHookService.getPort();
      const token = agentHookService.getToken();
      const colorEnv = await getTerminalColorEnv();

      // Open this session's Switch connection before the session exists, and
      // hand it the id. Its tool calls then arrive on the connection switchdash
      // is reading, so `connect_to_room` claims the room *there* and the server
      // tells us which room the session is in. Before this, the two held
      // separate connections and switchdash had to infer the room by scraping
      // the agent's tool response through a hook.
      //
      // Order matters: the server refuses a call naming a connection that is
      // not open, and the session may call connect_to_room immediately.
      // Null when the session has no Switch credentials — most sessions —
      // in which case nothing here applies and the var is simply absent.
      const switchConnectionId = await switchNotificationPoller.ensureForSession({
        sessionId: this.sessionId,
        providerId: session.providerId,
        ptyId,
      });

      // The Claude Code plugin resolves its MCP server with `npx` from a
      // private registry, so the session needs to know where that registry is
      // and how to authenticate. Empty when `gh` has no token, which lets the
      // session start regardless — a session with no MCP server beats no
      // session, and the missing login is reported at host setup.
      const npmAuthEnv = await npmRegistryAuthEnv();

      const sessionEnv = {
        ...buildAgentEnv({
          hook: port > 0 ? { port, ptyId, token } : undefined,
          providerVars,
          shellProfile: this.shellProfile,
        }),
        ...colorEnv,
        ...this.sessionEnvVars,
        ...identityVars,
        ...npmAuthEnv,
        ...(switchConnectionId ? { SWITCH_CONNECTION_ID: switchConnectionId } : {}),
      };

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
          paneEnv: tmuxSessionName ? sessionEnv : undefined,
        },
      });

      logLocalPtySpawnWarnings('LocalAgentRuntime', resolved.warnings, {
        sessionId: ptySessionId,
      });

      const pty = spawnLocalPty({
        id: ptySessionId,
        command: resolved.command,
        args: resolved.args,
        cwd: resolved.cwd,
        env: sessionEnv,
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
        .restoreConnection({
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
