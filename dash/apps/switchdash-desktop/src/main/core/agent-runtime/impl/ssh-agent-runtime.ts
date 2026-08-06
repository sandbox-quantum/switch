import type { PluginFs, SwitchLaunchSpecialization } from '@switchdash/core/agents/plugins';
import { DEEPLINK_SCHEME } from '@main/app/deeplinks';
import { agentHookService } from '@main/core/agent-hooks/agent-hook-service';
import { resolveAgentLaunchProfile } from '@main/core/agent-runtime/agent-launch-profile';
import { AgentRuntimeSupervisor } from '@main/core/agent-runtime/agent-runtime-supervisor';
import { resolveAgentSessionCommandArgs } from '@main/core/agent-runtime/resolve-agent-session-command';
import type { AgentRuntimeProvider } from '@main/core/agent-runtime/types';
import { agentCredsSlug } from '@main/core/agents/agent-creds-slug';
import { getAgentById } from '@main/core/agents/getAgentById';
import { reapStaleSidecarsForAgent } from '@main/core/agents/reap-stale-sidecars';
import { createRemoteAgentSecretStore } from '@main/core/agents/switch-agent-secrets';
import { hostDependencyStore } from '@main/core/dependencies/host-dependency-store';
import type { IExecutionContext } from '@main/core/execution-context/types';
import type { FileSystemProvider } from '@main/core/fs/types';
import { getPlugin } from '@main/core/providers/plugin-registry';
import type { Pty } from '@main/core/pty/pty';
import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import { resolveSshCommand } from '@main/core/pty/spawn-utils';
import { openSsh2Pty } from '@main/core/pty/ssh2-pty';
import { getTerminalColorEnv } from '@main/core/pty/terminal-color-scheme';
import { killTmuxSession, makeAgentTmuxSessionName } from '@main/core/pty/tmux-session-name';
import { sessionHooks } from '@main/core/sessions/session-hooks';
import { providerOverrideSettings } from '@main/core/settings/provider-settings-service';
import { sshConnectionManager } from '@main/core/ssh/lifecycle/production-ssh-connection-manager';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import type { SshConnectionManagerEvent } from '@main/core/ssh/lifecycle/ssh-connection-manager';
import { remoteNpmRegistryAuthEnv } from '@main/core/switch-rooms/npm-registry-auth';
import {
  readAgentSwitchEnvFromFs,
  withAgentSecret,
} from '@main/core/switch-rooms/switch-credentials';
import { events } from '@main/lib/events';
import { runWithLogContext } from '@main/lib/log-context';
import { log } from '@main/lib/logger';
import { toSwitchSpecialization } from '@shared/core/agents/agent-provider-config';
import type { AgentSessionConfig } from '@shared/core/providers/agent-session';
import { agentSessionExitedChannel } from '@shared/core/providers/agentEvents';
import { buildAgentHookEnv } from '@shared/core/pty/hookEnv';
import { makePtyId } from '@shared/core/pty/ptyId';
import { makeAgentPtySessionId } from '@shared/core/pty/ptySessionId';
import type { Session } from '@shared/core/sessions/sessions';
import { SIDECAR_VERSION } from '../../../../sidecar/sidecar-version';
import { ensureAgentSidecar, probeAgentSidecar } from './ensure-agent-sidecar';
import { scheduleInitialPromptInjection } from './keystroke-injection';
import { createRemoteHomePluginFs } from './remote-home-plugin-fs';
import { RemoteHookEventRelay } from './remote-hook-event-relay';
import { createRemotePluginFs } from './remote-plugin-fs';
import type { SidecarEndpoint, SidecarHost } from './remote-sidecar-launcher';
import { resolveAgentExecutable } from './resolve-agent-executable';
import {
  httpPostForJsonOverChannel,
  httpPostJsonOverChannel,
  SidecarHttpStatusError,
} from './sidecar-http';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const RESPAWN_DELAY_MS = 500;
const SHELL_NOT_FOUND_EXIT_CODE = 127;
const SIDECAR_DISCONNECT_TIMEOUT_MS = 5_000;
const SIDECAR_CONNECTION_TIMEOUT_MS = 10_000;

function parseExtraArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.trim().split(/\s+/);
}

export class SshAgentRuntime implements AgentRuntimeProvider {
  private pty: Pty | null = null;
  private known = false;
  /** The session this runtime last started — kept for reconnect rehydration. */
  private session: Session | null = null;
  private relay: RemoteHookEventRelay | null = null;
  /** Last resolved sidecar endpoint (agent-scoped, shared by all sessions on the
   * VM), captured at launch so a delete can POST /disconnect without re-ensuring. */
  private sidecarEndpoint: SidecarEndpoint | null = null;
  private supervisor = new AgentRuntimeSupervisor();
  private readonly handleConnectionEvent: (evt: SshConnectionManagerEvent) => void;
  private readonly locationId: string;
  private readonly sessionPath: string;
  private readonly sessionId: string;
  private readonly sessionEnvVars: Record<string, string>;
  private readonly tmux: boolean;
  private readonly shellSetup?: string;
  private readonly ctx: IExecutionContext;
  private readonly fs: FileSystemProvider;
  private readonly proxy: SshClientProxy;
  private readonly connectionId: string;

  constructor({
    locationId,
    sessionPath,
    sessionId,
    sessionEnvVars = {},
    tmux = false,
    shellSetup,
    ctx,
    fs,
    proxy,
    connectionId,
  }: {
    locationId: string;
    sessionPath: string;
    sessionId: string;
    sessionEnvVars?: Record<string, string>;
    tmux?: boolean;
    shellSetup?: string;
    ctx: IExecutionContext;
    fs: FileSystemProvider;
    proxy: SshClientProxy;
    connectionId: string;
  }) {
    this.locationId = locationId;
    this.sessionPath = sessionPath;
    this.sessionId = sessionId;
    this.sessionEnvVars = sessionEnvVars;
    this.tmux = tmux;
    this.shellSetup = shellSetup;
    this.ctx = ctx;
    this.fs = fs;
    this.proxy = proxy;
    this.connectionId = connectionId;
    this.handleConnectionEvent = (evt: SshConnectionManagerEvent) => {
      if (evt.type === 'reconnected' && evt.connectionId === this.connectionId) {
        this.rehydrate().catch((e: unknown) => {
          log.error('SshAgentRuntime: rehydrate after reconnect failed', {
            connectionId: this.connectionId,
            error: String(e),
          });
        });
      }
    };
    sshConnectionManager.on('connection-event', this.handleConnectionEvent);
  }

  /** The registry key of this session's agent PTY. */
  private get ptySessionId(): string {
    return makeAgentPtySessionId(this.locationId, this.sessionId);
  }

  /**
   * Re-attach the remote session if it was live before an SSH drop but its
   * interactive PTY died with the connection. On tmux hosts the agent process
   * survives inside its pane and the on-VM sidecar keeps running, so this only
   * re-opens the local PTY onto the existing pane — the sidecar and its
   * self-healing event relay are reused rather than relaunched.
   */
  private async rehydrate(): Promise<void> {
    if (!this.known || this.pty) return;
    if (!this.supervisor.isDesired()) return;
    const session = this.session;
    if (!session) return;
    return this.withLogScope(() => this.rehydrateInternal(session));
  }

  private async rehydrateInternal(session: Session): Promise<void> {
    const size = ptySessionRegistry.getLastSize(this.ptySessionId) ?? {
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    };
    log.info('SshAgentRuntime: re-attaching session after reconnect', {
      sessionId: this.sessionId,
    });
    await this.startInternal(session, size, true, undefined, true, {
      shellRefreshRetried: false,
    }).catch((e: unknown) => {
      log.error('SshAgentRuntime: re-attach failed', {
        sessionId: this.sessionId,
        error: String(e),
      });
    });
  }

  private createSidecarHost(): SidecarHost {
    const ctx = this.ctx;
    const fs = this.fs;
    return {
      exec: (command, args) => ctx.exec(command, args),
      putFile: (localAbsPath, remoteRelPath) => {
        if (!fs.copyLocalFile) {
          throw new Error(
            'SshAgentRuntime: remote filesystem does not support copyLocalFile; cannot deploy sidecar bundle'
          );
        }
        return fs.copyLocalFile(localAbsPath, remoteRelPath);
      },
    };
  }

  /**
   * Where a provider's hook config lives on the VM. A workspace-scoped provider
   * (Claude's `.claude/settings.local.json`) writes under the repo dir over
   * SFTP; a global-scoped one (Codex's `~/.codex/hooks.json`) writes under the
   * VM's home, which `this.fs` cannot reach at all.
   */
  private remoteHookFs(scope: 'global' | 'workspace'): PluginFs {
    if (scope === 'global') return createRemoteHomePluginFs(this.ctx);
    if (scope === 'workspace') return createRemotePluginFs(this.fs);
    throw new Error(
      `SshAgentRuntime: no remote hook root for scope '${String(scope)}' — the session would ` +
        'run with no hooks, reporting neither its provider session id nor when it stops'
    );
  }

  /**
   * Install the provider's agent hooks onto the VM, mirroring what
   * `ensureHooksInstalled` does for local sessions. The remote agent is spawned
   * with the `SWITCHDASH_HOOK_*` env vars, but those only matter if its config
   * actually registers the hook commands — otherwise the agent posts no
   * lifecycle events to the sidecar, so its provider session id is never
   * captured (every resume silently starts a new conversation) and the room's
   * "working on it" never clears. Writing is best-effort: a failure is logged,
   * not fatal.
   */
  private async installRemoteHooks(providerId: string): Promise<void> {
    const plugin = getPlugin(providerId);
    const hooks = plugin.capabilities.hooks;
    if (hooks.kind === 'none') return;
    if (hooks.kind !== 'config' || !plugin.behavior.hooks) {
      log.error('SshAgentRuntime: provider hooks cannot be installed on a remote host', {
        providerId,
        kind: hooks.kind,
      });
      return;
    }
    const fs = this.remoteHookFs(hooks.scope);
    try {
      await plugin.behavior.hooks.writeHooks(fs, []);
      log.info('SshAgentRuntime: installed remote agent hooks', {
        providerId,
        scope: hooks.scope,
      });
    } catch (error) {
      log.error('SshAgentRuntime: failed to install remote agent hooks', {
        providerId,
        scope: hooks.scope,
        error: String(error),
      });
    }
  }

  /**
   * Write the per-agent launch files of a provider that needs them under the
   * VM's home (Codex: a profile carrying model / effort / instructions).
   * Returns the argv that loads them, or `[]` when there is nothing to write.
   */
  private async writeRemoteLaunchProfile(
    plugin: ReturnType<typeof getPlugin>,
    slug: string,
    specialization: SwitchLaunchSpecialization | undefined
  ): Promise<string[]> {
    const profile = resolveAgentLaunchProfile(plugin, {
      slug,
      workingDir: this.sessionPath,
      specialization,
    });
    if (!profile) return [];

    const homeFs = createRemoteHomePluginFs(this.ctx);
    for (const file of profile.files) {
      await homeFs.write(file.relativePath, file.content);
    }
    return profile.args;
  }

  private async launchSidecar(session: Session): Promise<SidecarEndpoint> {
    // One agent-scoped sidecar serves every session on the VM (this one and any
    // the sidecar's own watcher auto-starts) — ensure it is running and point
    // this session's hooks at its shared hook server. Reattaches if already up.
    // The launch spec governs the watcher's auto-started sessions, so it carries
    // the agent's bypass-permissions setting (not this UI session's).
    const agent = await getAgentById(session.agentId);
    const host = this.createSidecarHost();
    const endpoint = await ensureAgentSidecar({
      providerId: session.providerId,
      repoDir: this.sessionPath,
      deeplinkScheme: DEEPLINK_SCHEME,
      autoApprove: agent?.autoApprove ?? false,
      credsSlug: agentCredsSlug(session),
      agentName: agent?.name ?? session.agentName ?? null,
      specialization: toSwitchSpecialization(agent?.providerConfig),
      ctx: this.ctx,
      connectionId: this.connectionId,
      host,
    });
    // Drop any sidecar left in this directory by an earlier generation of the
    // agent's name — it is still polling Switch and no other path can see it.
    if (agent) await reapStaleSidecarsForAgent(agent, host, this.sessionPath);
    this.sidecarEndpoint = endpoint;
    this.startRelay(endpoint);
    return endpoint;
  }

  /**
   * Tell the on-VM sidecar to drop this session's room connection so its
   * poll + renew heartbeat stops — otherwise the agent keeps renewing and shows
   * `live` in the room with no session behind it (CHOO-1106). Best-effort: a
   * failure is logged, not thrown (the reconciler tombstone is the backstop). No
   * endpoint means no sidecar was ever launched for this provider — nothing to do.
   */
  private async disconnectSidecarSession(sessionId: string, terminated: boolean): Promise<void> {
    const endpoint = this.sidecarEndpoint;
    if (!endpoint) return;
    // Bound the whole round-trip: opening the SSH channel can itself hang on a
    // half-open connection, and deletion must not wait on it — the reconciler
    // tombstone is the backstop if this never lands.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('sidecar disconnect timed out')),
        SIDECAR_DISCONNECT_TIMEOUT_MS
      );
    });
    try {
      await Promise.race([this.postDisconnect(endpoint, sessionId, terminated), timeout]);
    } catch (error) {
      log.warn('SshAgentRuntime: failed to disconnect sidecar session', {
        sessionId,
        error: String(error),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Open this session's Switch connection on the VM's sidecar and return the id
   * to hand it in its environment.
   *
   * The session's room is claimed on the connection whose id it carries, and
   * only whoever reads that connection sees the room's events. On a remote host
   * that reader is the sidecar — switchdash's own poller stands down for remote
   * sessions and the in-session runtime's poll is disabled — so a session left
   * to mint its own connection is addressable by nobody and never learns its
   * room. Opened before the launch because the server refuses a call naming a
   * connection that is not open, and the agent may call connect_to_room at once.
   */
  private async openSidecarConnection(
    endpoint: SidecarEndpoint,
    providerId: string
  ): Promise<string> {
    const channel = await this.proxy.forwardOut(endpoint.port);
    let response: { connectionId?: unknown };
    try {
      response = await httpPostForJsonOverChannel<{ connectionId?: unknown }>(channel, {
        port: endpoint.port,
        token: endpoint.token,
        path: '/connection',
        body: { sessionId: this.sessionId, providerId },
        timeoutMs: SIDECAR_CONNECTION_TIMEOUT_MS,
      });
    } catch (error) {
      // Starting anyway would reproduce exactly the silence this exists to
      // prevent, so refuse either way — but a 404 is its own diagnosis: the
      // sidecar on this host predates the endpoint, and restarting it from the
      // agent's sidecar panel upgrades it (an idle one upgrades itself).
      const stale =
        error instanceof SidecarHttpStatusError && error.status === 404
          ? ` The sidecar on this host is older than ${SIDECAR_VERSION} and has no /connection endpoint; restart it to upgrade.`
          : '';
      throw new Error(
        `SshAgentRuntime: the sidecar did not open a Switch connection for this session ` +
          `(${String(error)}).${stale}`
      );
    } finally {
      channel.destroy();
    }
    const connectionId = response.connectionId;
    if (typeof connectionId !== 'string' || !connectionId) {
      throw new Error('SshAgentRuntime: sidecar /connection returned no connection id');
    }
    return connectionId;
  }

  private async postDisconnect(
    endpoint: { port: number; token: string },
    sessionId: string,
    terminated: boolean
  ): Promise<void> {
    const channel = await this.proxy.forwardOut(endpoint.port);
    try {
      await httpPostJsonOverChannel(channel, {
        port: endpoint.port,
        token: endpoint.token,
        path: '/disconnect',
        body: { sessionId, terminated },
        timeoutMs: SIDECAR_DISCONNECT_TIMEOUT_MS,
      });
    } finally {
      channel.destroy();
    }
  }

  /**
   * Mirror the sidecar's hook events back into switchdash so its UI reflects the
   * remote session's room and status. Replays through the same hook path as
   * local sessions, but with `startLocalPoller: false` — the sidecar already
   * polls and injects on the VM.
   */
  private startRelay(endpoint: SidecarEndpoint): void {
    this.relay?.stop();
    const proxy = this.proxy;
    const relay = new RemoteHookEventRelay({
      opener: { openChannel: (port) => proxy.forwardOut(port) },
      port: endpoint.port,
      token: endpoint.token,
      // Follow the sidecar if it restarts on a different port with a new token,
      // instead of polling the dead one for the rest of the app's life. Probe,
      // never launch: a relay must not resurrect a sidecar the user stopped.
      resolveEndpoint: async () => {
        const session = this.session;
        if (!session) return null;
        const agent = await getAgentById(session.agentId);
        const next = await probeAgentSidecar({
          providerId: session.providerId,
          repoDir: this.sessionPath,
          deeplinkScheme: DEEPLINK_SCHEME,
          autoApprove: agent?.autoApprove ?? false,
          credsSlug: agentCredsSlug(session),
          agentName: agent?.name ?? session.agentName ?? null,
          specialization: toSwitchSpecialization(agent?.providerConfig),
          ctx: this.ctx,
          connectionId: this.connectionId,
          host: this.createSidecarHost(),
        });
        // Keep the cached endpoint used by /disconnect in step with the relay.
        if (next) this.sidecarEndpoint = next;
        return next;
      },
      sink: async (raw) => {
        if (raw.type === 'session-terminated') {
          this.onRemoteTerminated(raw.body);
          return;
        }
        await agentHookService.handleRawHook(raw, { startLocalPoller: false });
      },
      // Bound explicitly rather than inherited: the relay polls on its own timer
      // for the lifetime of the session, and a scope captured from whatever call
      // happened to start it would drift out of date.
      log: log.child({
        component: 'hook-relay',
        sessionId: this.sessionId,
        agentId: this.session?.agentId,
        agentName: this.session?.agentName ?? undefined,
      }),
    });
    this.relay = relay;
    relay.start();
  }

  private stopRelay(): void {
    const relay = this.relay;
    if (!relay) return;
    this.relay = null;
    relay.stop();
  }

  private stopSidecar(): void {
    // Only detach this session's relay. The sidecar is agent-scoped and shared
    // (other sessions + its notification watcher rely on it), so ending one
    // session must not kill it — it is torn down when auto_session is disabled
    // or the agent is removed (see stopRemoteWatcher).
    this.stopRelay();
  }

  /**
   * Run inside this runtime's log scope.
   *
   * Remote agent work is driven by watchers and reconnect events rather than by
   * an RPC call, so there is no ambient context to inherit — it is established
   * here instead. Everything below reports which session and agent it belongs
   * to without any intermediate signature carrying the ids.
   */
  private withLogScope<T>(fn: () => T): T {
    return runWithLogContext(
      {
        component: 'ssh-agent-runtime',
        sessionId: this.sessionId,
        agentId: this.session?.agentId,
        agentName: this.session?.agentName ?? undefined,
      },
      fn
    );
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
    // Bound before the assignment inside startInternal, so the agent fields come
    // from the session being started rather than a stale one.
    return runWithLogContext(
      {
        component: 'ssh-agent-runtime',
        sessionId: this.sessionId,
        agentId: session.agentId,
        agentName: session.agentName ?? undefined,
      },
      () =>
        this.startInternal(session, initialSize, isResuming, initialPrompt, false, {
          shellRefreshRetried: false,
        })
    );
  }

  private async startInternal(
    session: Session,
    initialSize: { cols: number; rows: number },
    isResuming: boolean,
    initialPrompt: string | undefined,
    requireDesired: boolean,
    options: { shellRefreshRetried: boolean }
  ): Promise<void> {
    const ptySessionId = this.ptySessionId;
    this.known = true;
    this.session = session;

    // Declared out here so a launch that fails after the sidecar opened this
    // session's connection can hand it back. Left open it keeps renewing, and
    // the agent shows `live` in its room with no session behind it (CHOO-1106).
    let switchEnv: Record<string, string> = {};

    const spawnSize = ptySessionRegistry.getLastSize(ptySessionId) ?? initialSize;
    const spawnToken = this.supervisor.beginStart({
      requireDesired,
      mode: isResuming ? 'resume' : 'fresh',
    });
    if (!spawnToken) return;

    try {
      const providerConfig = await providerOverrideSettings.getItem(session.providerId);
      const agentSession = resolveAgentSessionCommandArgs(session, isResuming);
      const plugin = getPlugin(session.providerId);
      const repoAgents = plugin.behavior.repoAgents;

      const binaryName = plugin.capabilities.hostDependency.binaryNames[0] ?? session.providerId;
      const executableCli = await resolveAgentExecutable({
        providerId: session.providerId,
        binaryName,
        ctx: this.ctx,
        hostDependencyStore,
        connectionId: this.connectionId,
      });

      // The agent's Switch identity as real env vars (highest precedence): read
      // from its neutral `.switch/agents/<slug>.json` on the VM. A `--settings`
      // file's env block is not reliably propagated to the spawned MCP server, so
      // inject it directly, matching the local runtime.
      // Resolved before the command is built because a provider that registers the
      // Switch server at launch keys it on this identity (see below).
      const remoteFs = createRemotePluginFs(this.fs);
      const identityVars = await withAgentSecret(
        session.agentName && repoAgents
          ? await repoAgents.readLaunchEnv(remoteFs, session.agentName)
          : await readAgentSwitchEnvFromFs(remoteFs, agentCredsSlug(session), log),
        createRemoteAgentSecretStore(this.ctx),
        log
      );

      const agentRecord = await getAgentById(session.agentId);
      // Read from the agent, not the session: the session's copy is frozen at
      // creation, so an existing session never picked up the toggle. See the
      // matching comment in local-agent-runtime.
      const autoApprove = agentRecord?.autoApprove ?? session.autoApprove ?? false;
      // Codex writes a profile under the VM's ~/.codex for model / effort /
      // instructions. The Switch MCP server comes from the connector plugin's
      // own `.mcp.json`, on the VM as locally.
      const launchProfileArgs = await this.writeRemoteLaunchProfile(
        plugin,
        agentCredsSlug(session),
        toSwitchSpecialization(agentRecord?.providerConfig)
      );

      const agentCommand = plugin.behavior.prompt!.buildCommand({
        cli: executableCli,
        extraArgs: parseExtraArgs(providerConfig?.extraArgs),
        // A remote agent runs as its own definition: the provider produces the
        // run-as-name args (Claude → `--agent <name> --settings <neutral creds>`),
        // resolved on the VM (sessionPath is remote). Distinct from user extra
        // args (CHOO-1440). The provider also owns how it loads its per-agent
        // specialization when that needs a config file.
        agentArgs: [
          ...(session.agentName && repoAgents
            ? repoAgents.launchArgs(this.sessionPath, session.agentName)
            : []),
          ...launchProfileArgs,
        ],
        autoApprove,
        initialPrompt: agentSession.isResuming ? undefined : initialPrompt,
        sessionId: agentSession.sessionId,
        providerSessionId: session.providerSessionId ?? undefined,
        isResuming: agentSession.isResuming,
        model: '',
      });

      const customEnv = providerConfig?.env ?? {};
      const providerEnv: Record<string, string> = { ...agentCommand.env, ...customEnv };

      const tmuxSessionName = this.tmux ? makeAgentTmuxSessionName(this.sessionId) : undefined;

      const cfg: AgentSessionConfig = {
        sessionId: this.sessionId,
        providerId: session.providerId,
        command: agentCommand.command,
        args: agentCommand.args,
        cwd: this.sessionPath,
        shellSetup: this.shellSetup,
        tmuxSessionName,
        autoApprove,
        resume: agentSession.isResuming,
      };

      // The on-VM sidecar is what keeps a remote agent connected to Switch while
      // switchdash is closed; it injects room messages into the agent's tmux pane.
      // It therefore requires tmux, must be up before the agent so the agent's
      // hook env can point at it, and shares the tmux session as its inject target.
      // Decided before the branch below, not inside it: `launchSidecar()`
      // assigns `this.relay`, so once it has run a fresh launch is
      // indistinguishable from a re-attach.
      const reattaching = Boolean(tmuxSessionName && this.relay);

      let hookEnv: Record<string, string> = {};
      if (reattaching) {
        // Re-attach path (e.g. after an SSH reconnect): the agent is still
        // running in its tmux pane and the sidecar + its self-healing relay are
        // already live, so re-open the PTY onto the existing pane and skip the
        // hook install + sidecar launch. The running agent keeps its original
        // hook env, so we need not re-supply it.
        log.info('SshAgentRuntime: re-attaching to running tmux session + sidecar', {
          sessionId: this.sessionId,
        });
      } else if (tmuxSessionName) {
        const ptyId = makePtyId(session.providerId, this.sessionId);
        // Install the agent's hooks into the remote workspace before launch so
        // the hook env below actually has commands to run — without this the
        // remote agent posts nothing to the sidecar (local sessions get this via
        // ensureHooksInstalled).
        await this.installRemoteHooks(session.providerId);
        const endpoint = await this.launchSidecar(session);
        hookEnv = buildAgentHookEnv({
          port: endpoint.port,
          ptyId,
          token: endpoint.token,
          endpointFile: endpoint.endpointFile,
        });
        switchEnv = {
          SWITCH_CONNECTION_ID: await this.openSidecarConnection(endpoint, session.providerId),
        };
      } else {
        log.warn(
          'SshAgentRuntime: tmux disabled — remote agent will not stay connected to Switch while detached',
          { sessionId: this.sessionId }
        );
      }

      // Skipped on the re-attach path above: the pane already has its
      // environment and tmux applies `-e` only when it creates a session, so
      // recomputing this would cost two round trips and change nothing.
      const npmAuthEnv = reattaching
        ? {}
        : await remoteNpmRegistryAuthEnv(this.ctx, this.sessionPath);

      const [profile, colorEnv] = await Promise.all([
        this.proxy.getRemoteShellProfile(),
        getTerminalColorEnv(),
      ]);
      const sshCommand = resolveSshCommand(
        'agent',
        cfg,
        {
          ...providerEnv,
          ...colorEnv,
          ...this.sessionEnvVars,
          ...hookEnv,
          ...npmAuthEnv,
          ...identityVars,
          ...switchEnv,
        },
        profile
      );

      const result = await openSsh2Pty(this.proxy, {
        id: ptySessionId,
        command: sshCommand,
        cols: spawnSize.cols,
        rows: spawnSize.rows,
      });

      if (!result.success) {
        log.error('SshAgentRuntime: failed to open SSH channel', {
          sessionId: ptySessionId,
          error: result.error.message,
        });
        throw new Error(result.error.message);
      }

      const pty = result.data;

      pty.onExit((info) => {
        const { exitCode } = info;
        const decision = this.supervisor.handleExit(pty);
        if (decision.kind === 'stale') return;
        const replacementSize = ptySessionRegistry.getLastSize(ptySessionId) ?? spawnSize;

        ptySessionRegistry.unregister(ptySessionId, { pty, exitInfo: info });
        this.pty = null;
        if (decision.kind === 'stopped') return;

        this.emitExited();

        if (this.tmux) return;

        if (exitCode === SHELL_NOT_FOUND_EXIT_CODE && !options.shellRefreshRetried) {
          this.scheduleShellRefreshRetry({
            session,
            initialSize: replacementSize,
            isResuming: decision.kind === 'respawnResume',
            initialPrompt,
          });
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
          isRemote: true,
        },
      });
      this.pty = pty;
      scheduleInitialPromptInjection({
        pty,
        session,
        initialPrompt,
        isResuming: agentSession.isResuming,
      });
    } catch (error) {
      this.supervisor.failSpawn(spawnToken);
      if (switchEnv.SWITCH_CONNECTION_ID) {
        await this.disconnectSidecarSession(this.sessionId, false);
      }
      throw error;
    }
  }

  private emitExited(): void {
    events.emit(agentSessionExitedChannel, { sessionId: this.sessionId });
    sessionHooks._emit('session:agent-exited', { sessionId: this.sessionId });
  }

  private detachPty(): void {
    const pty = this.supervisor.stop() ?? this.pty;
    this.pty = null;
    ptySessionRegistry.unregister(this.ptySessionId);
    if (pty) {
      try {
        pty.kill();
      } catch (e) {
        log.warn('SshAgentRuntime: error killing PTY', {
          sessionId: this.sessionId,
          error: String(e),
        });
      }
    }
  }

  async dehydrate(): Promise<void> {
    this.detachPty();
    if (!this.tmux) {
      this.known = false;
      this.supervisor.forget();
    }
  }

  async stop(): Promise<void> {
    await this.teardownSession({ disconnectSidecar: true, killTmux: true });
  }

  /**
   * Tear down this client's local state for the session. `disconnectSidecar` +
   * `killTmux` are true for a deliberate delete/kill originating here (which also
   * makes the sidecar broadcast a `session-terminated` event). They are false on
   * the receiving side of that broadcast (`onRemoteTerminated`): the initiator
   * already dropped the sidecar connection and killed the tmux session, so
   * repeating either here would be wasteful and — for the disconnect — would
   * re-broadcast in a loop.
   */
  private async teardownSession(opts: {
    disconnectSidecar: boolean;
    killTmux: boolean;
  }): Promise<void> {
    this.known = false;
    this.session = null;
    if (this.tmux && opts.disconnectSidecar) {
      await this.disconnectSidecarSession(this.sessionId, true);
    }
    this.stopSidecar();
    this.detachPty();
    if (this.tmux && opts.killTmux) {
      await killTmuxSession(this.ctx, makeAgentTmuxSessionName(this.sessionId));
    }
    this.supervisor.forget();
  }

  /**
   * Handle a `session-terminated` broadcast from the sidecar: another client (or
   * this one) deliberately deleted a session on this VM. The shared sidecar
   * broadcasts to every session's relay, so the terminated id may belong to a
   * different session — local state is only torn down when it is ours, but the
   * DB-level cleanup is signalled either way so the session row is removed
   * everywhere and cannot be re-attached into a blank session.
   */
  private onRemoteTerminated(rawBody: string): void {
    let terminatedSessionId = '';
    try {
      const parsed = JSON.parse(rawBody) as { sessionId?: unknown };
      if (typeof parsed.sessionId === 'string') terminatedSessionId = parsed.sessionId;
    } catch {
      terminatedSessionId = '';
    }
    if (!terminatedSessionId) {
      log.warn('SshAgentRuntime: session-terminated event missing sessionId');
      return;
    }
    if (terminatedSessionId === this.sessionId) {
      void this.teardownSession({ disconnectSidecar: false, killTmux: false }).catch(
        (e: unknown) => {
          log.warn('SshAgentRuntime: error tearing down terminated session', {
            sessionId: terminatedSessionId,
            error: String(e),
          });
        }
      );
    }
    sessionHooks._emit('session:remote-terminated', {
      locationId: this.locationId,
      sessionId: this.sessionId,
      terminatedSessionId,
    });
  }

  async destroy(): Promise<void> {
    sshConnectionManager.off('connection-event', this.handleConnectionEvent);
    const wasKnown = this.known;
    await this.detach();
    if (this.tmux && wasKnown) {
      await this.disconnectSidecarSession(this.sessionId, true);
    }
    this.stopSidecar();
    this.session = null;
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
      try {
        pty.kill();
      } catch {}
      ptySessionRegistry.unregister(this.ptySessionId);
      this.pty = null;
    }
  }

  private scheduleShellRefreshRetry({
    session,
    initialSize,
    isResuming,
    initialPrompt,
  }: {
    session: Session;
    initialSize: { cols: number; rows: number };
    isResuming: boolean;
    initialPrompt: string | undefined;
  }): void {
    setTimeout(() => {
      if (!this.supervisor.isDesired()) return;
      this.proxy
        .refreshRemoteShellProfile()
        .then(() => {
          if (!this.supervisor.isDesired()) return;
          return this.startInternal(session, initialSize, isResuming, initialPrompt, true, {
            shellRefreshRetried: true,
          });
        })
        .catch((e) => {
          log.error('SshAgentRuntime: shell refresh retry failed', {
            sessionId: this.sessionId,
            error: String(e),
          });
        });
    }, RESPAWN_DELAY_MS);
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
      this.startInternal(session, initialSize, isResuming, undefined, true, {
        shellRefreshRetried: false,
      }).catch((e) => {
        log.error('SshAgentRuntime: replacement failed', {
          sessionId: this.sessionId,
          error: String(e),
        });
      });
    }, RESPAWN_DELAY_MS);
  }
}
