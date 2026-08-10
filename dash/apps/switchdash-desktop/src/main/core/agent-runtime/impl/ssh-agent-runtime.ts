import type { PluginFs, SwitchLaunchSpecialization } from '@switchdash/core/agents/plugins';
import { DEEPLINK_SCHEME } from '@main/app/deeplinks';
import { agentHookService } from '@main/core/agent-hooks/agent-hook-service';
import { resolveAgentLaunchProfile } from '@main/core/agent-runtime/agent-launch-profile';
import { AgentRuntimeSupervisor } from '@main/core/agent-runtime/agent-runtime-supervisor';
import type { AttachableRuntime } from '@main/core/agent-runtime/attachment/types';
import { resolveAgentSessionCommandArgs } from '@main/core/agent-runtime/resolve-agent-session-command';
import type { AgentRuntimeProvider } from '@main/core/agent-runtime/types';
import { agentCredsSlug } from '@main/core/agents/agent-creds-slug';
import { getAgentById } from '@main/core/agents/getAgentById';
import { reapStaleSidecarsForAgent } from '@main/core/agents/reap-stale-sidecars';
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
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import { remoteNpmRegistryAuthEnv } from '@main/core/switch-rooms/npm-registry-auth';
import { readAgentSwitchEnvFromFs } from '@main/core/switch-rooms/switch-credentials';
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
import { createRemotePluginFs } from './remote-plugin-fs';
import type { SidecarEndpoint, SidecarHost } from './remote-sidecar-launcher';
import { resolveAgentExecutable } from './resolve-agent-executable';
import {
  httpPostForJsonOverChannel,
  httpPostJsonOverChannel,
  SidecarHttpStatusError,
} from './sidecar-http';
import { sidecarRelayKey, sidecarRelayRegistry } from './sidecar-relay-registry';

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

/**
 * Coalesce concurrent calls that do the same per-workspace work.
 *
 * Sidecar ensure and hook install are keyed by repo dir, not by session, so
 * every session in a dir would otherwise repeat them — on one real host that
 * meant 51 identical SFTP writes and tmux probes racing at startup. Only
 * in-flight calls are shared; once settled the next caller does the work again,
 * so this coalesces a burst without caching a result that can go stale.
 */
function dedupeInFlight<T>(
  registry: Map<string, Promise<T>>,
  key: string,
  work: () => Promise<T>
): Promise<T> {
  const inFlight = registry.get(key);
  if (inFlight) return inFlight;
  const promise = work().finally(() => {
    if (registry.get(key) === promise) registry.delete(key);
  });
  registry.set(key, promise);
  return promise;
}

/** Keyed by sidecar (`connectionId::repoDir::credsSlug`). */
const sidecarEnsuresInFlight = new Map<string, Promise<SidecarEndpoint>>();
/** Keyed by `connectionId::repoDir::providerId`. The written paths are unused. */
const remoteHookInstallsInFlight = new Map<string, Promise<unknown>>();

export class SshAgentRuntime implements AgentRuntimeProvider, AttachableRuntime {
  private pty: Pty | null = null;
  private known = false;
  /** The session this runtime last started — kept for reconnect rehydration. */
  private session: Session | null = null;
  /** Key of the shared sidecar relay this session subscribes to, when joined. */
  private relayKey: string | null = null;
  /** True once the sidecar is up and the relay joined — the `ensureAttachable` guard. */
  private sidecarReady = false;
  /** True once this runtime has opened the tmux pane, so a later attach lands on
   * an existing agent rather than creating one. Survives eviction (the pane
   * outlives the PTY); cleared only when the session is torn down. */
  private launched = false;
  /** Hook env pointing the agent at its sidecar; resolved by `ensureAttachable`. */
  private hookEnv: Record<string, string> = {};
  /** Last resolved sidecar endpoint (agent-scoped, shared by all sessions on the
   * VM), captured at launch so a delete can POST /disconnect without re-ensuring. */
  private sidecarEndpoint: SidecarEndpoint | null = null;
  private supervisor = new AgentRuntimeSupervisor();
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
    // Deliberately no per-runtime `connection-event` listener: every session on
    // a host would re-attach in the same tick on reconnect, which is what
    // saturated the shared transport and re-tripped the wedge watchdog.
    // `RemoteAttachmentPool` owns one listener per connection and replays a
    // bounded, staggered set instead.
  }

  // ─── AttachableRuntime ───────────────────────────────────────────────────

  get attachHostKey(): string {
    return this.connectionId;
  }

  get attachSessionId(): string {
    return this.sessionId;
  }

  isAttached(): boolean {
    return this.pty !== null;
  }

  /**
   * Bring up everything except the PTY: the on-VM sidecar and the shared
   * hook-event relay, plus the hook env the agent is launched with.
   *
   * Called at provision time so a session that is never opened still reports
   * status, room membership and notifications — all of which arrive over the
   * relay, not the terminal. Idempotent.
   */
  async ensureAttachable(session: Session): Promise<void> {
    this.known = true;
    this.session = session;
    if (!this.tmux) return;
    if (this.sidecarReady) return;

    // Install the agent's hooks into the remote workspace before launch so the
    // hook env actually has commands to run — without this the remote agent
    // posts nothing to the sidecar (local sessions get this via
    // ensureHooksInstalled).
    await this.installRemoteHooks(session.providerId);
    const endpoint = await this.launchSidecar(session);
    this.hookEnv = buildAgentHookEnv({
      port: endpoint.port,
      ptyId: makePtyId(session.providerId, this.sessionId),
      token: endpoint.token,
      endpointFile: endpoint.endpointFile,
    });
    this.sidecarReady = true;
  }

  /** Close the local PTY but leave the agent running in tmux and the relay joined. */
  async detachForEviction(): Promise<void> {
    await this.dehydrate();
  }

  /** The registry key of this session's agent PTY. */
  private get ptySessionId(): string {
    return makeAgentPtySessionId(this.locationId, this.sessionId);
  }

  /**
   * Open the local PTY onto the remote tmux pane. The agent process lives in
   * that pane and the on-VM sidecar keeps running regardless, so this only
   * re-opens the view — the sidecar and its shared event relay are reused
   * rather than relaunched.
   *
   * Deliberately does NOT gate on `supervisor.isDesired()`: `detachPty` clears
   * `desired`, so an evicted session could otherwise never be re-attached.
   * `beginStart` still short-circuits when a PTY is live or a spawn is already
   * in flight, so repeated calls remain safe.
   */
  async attach(): Promise<void> {
    if (this.pty) return;
    // Loud, because the pool has no way to see the difference: a runtime that
    // silently declines looks exactly like one that attached, and the terminal
    // stays blank with nothing in the log to explain it. A runtime reaches the
    // pool at provision time but only learns its session from `ensureAttachable`,
    // so this fires when provisioning skipped that step.
    if (!this.known || !this.session) {
      throw new Error(
        `SshAgentRuntime: cannot attach session ${this.sessionId} — the runtime was never made attachable (known=${this.known}, session=${this.session !== null})`
      );
    }
    const session = this.session;
    return this.withLogScope(() => this.attachInternal(session));
  }

  private async attachInternal(session: Session): Promise<void> {
    const size = ptySessionRegistry.getLastSize(this.ptySessionId) ?? {
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    };
    log.info('SshAgentRuntime: attaching session', { sessionId: this.sessionId });
    await this.startInternal(session, size, true, undefined, false, {
      shellRefreshRetried: false,
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
   *
   * The config file is per workspace (or per host), not per session, so
   * concurrent installs from every session in a dir are coalesced onto one write.
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
    const writeHooks = plugin.behavior.hooks.writeHooks;
    const fs = this.remoteHookFs(hooks.scope);
    // A global-scope write targets the VM's home, so it is shared by every dir
    // on the host; keying it on the dir would let one write per dir through.
    const scopeKey = hooks.scope === 'global' ? '~' : this.sessionPath;
    try {
      await dedupeInFlight(
        remoteHookInstallsInFlight,
        `${this.connectionId}::${scopeKey}::${providerId}`,
        () => writeHooks(fs, [])
      );
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
    const credsSlug = agentCredsSlug(session);
    // Every session in this dir would otherwise re-run the same deploy+launch on
    // startup; coalesce so one host sees one ensure, not one per session.
    const endpoint = await dedupeInFlight(
      sidecarEnsuresInFlight,
      sidecarRelayKey({ connectionId: this.connectionId, repoDir: this.sessionPath, credsSlug }),
      () =>
        ensureAgentSidecar({
          providerId: session.providerId,
          repoDir: this.sessionPath,
          deeplinkScheme: DEEPLINK_SCHEME,
          autoApprove: agent?.autoApprove ?? false,
          credsSlug,
          agentName: agent?.name ?? session.agentName ?? null,
          specialization: toSwitchSpecialization(agent?.providerConfig),
          ctx: this.ctx,
          connectionId: this.connectionId,
          host,
        })
    );
    // Drop any sidecar left in this directory by an earlier generation of the
    // agent's name — it is still polling Switch and no other path can see it.
    if (agent) await reapStaleSidecarsForAgent(agent, host, this.sessionPath);
    this.sidecarEndpoint = endpoint;
    this.joinRelay(endpoint, session, credsSlug);
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
   * Join the shared relay that mirrors the sidecar's hook events back into
   * switchdash, so the UI reflects this remote session's room and status.
   * Replays through the same hook path as local sessions, but with
   * `startLocalPoller: false` — the sidecar already polls and injects on the VM.
   *
   * One relay serves every session on the sidecar: its `/events` ring carries
   * all of them and `handleRawHook` routes each event by the `ptyId` the event
   * itself carries, so a per-session relay would only duplicate the poll and the
   * work. `session-terminated` is the exception and is fanned out to every
   * subscriber by the registry.
   */
  private joinRelay(endpoint: SidecarEndpoint, session: Session, credsSlug: string): void {
    this.relayKey = sidecarRelayKey({
      connectionId: this.connectionId,
      repoDir: this.sessionPath,
      credsSlug,
    });
    sidecarRelayRegistry.acquire({
      key: this.relayKey,
      credsSlug,
      subscriber: {
        sessionId: this.sessionId,
        onSessionTerminated: (body) => this.onRemoteTerminated(body),
      },
      opener: { openChannel: (port) => this.proxy.forwardOut(port) },
      port: endpoint.port,
      token: endpoint.token,
      // Follow the sidecar if it restarts on a different port with a new token,
      // instead of polling the dead one for the rest of the app's life. Probe,
      // never launch: a relay must not resurrect a sidecar the user stopped.
      // Resolved from the session captured here rather than `this.session`,
      // which is cleared on teardown while the shared relay lives on for the
      // other sessions.
      resolveEndpoint: async () => {
        const agent = await getAgentById(session.agentId);
        const next = await probeAgentSidecar({
          providerId: session.providerId,
          repoDir: this.sessionPath,
          deeplinkScheme: DEEPLINK_SCHEME,
          autoApprove: agent?.autoApprove ?? false,
          credsSlug,
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
        await agentHookService.handleRawHook(raw, { startLocalPoller: false });
      },
    });
  }

  /**
   * Leave the shared relay. Teardown only: evicting this session's PTY must not
   * call this, or the session would stop reporting status while its agent keeps
   * working in its tmux pane.
   */
  private leaveRelay(): void {
    const key = this.relayKey;
    if (!key) return;
    this.relayKey = null;
    this.sidecarReady = false;
    sidecarRelayRegistry.release(key, this.sessionId);
  }

  private stopSidecar(): void {
    // Only leave this session's shared relay. The sidecar is agent-scoped and
    // shared (other sessions + its notification watcher rely on it), so ending
    // one session must not kill it — it is torn down when auto_session is
    // disabled or the agent is removed (see stopRemoteWatcher).
    this.leaveRelay();
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
      const identityVars =
        session.agentName && repoAgents
          ? await repoAgents.readLaunchEnv(remoteFs, session.agentName)
          : await readAgentSwitchEnvFromFs(remoteFs, agentCredsSlug(session), log);

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
      //
      // `ensureAttachable` is idempotent, so this is a no-op when the session was
      // already made attachable at provision time. Passing the hook env on every
      // attach is safe: `buildTmuxShellLine` supplies it via `tmux new-session -e`,
      // which tmux applies only when it creates the session — an existing pane is
      // reused untouched.
      //
      // `reattaching` cannot be read off the sidecar being up: with on-demand
      // attachment the sidecar is running long before the first PTY. It tracks
      // whether this runtime has already opened the pane, which is what governs
      // the two steps that must happen once per pane rather than once per
      // attach — opening this session's sidecar connection, and resolving the
      // npm auth env.
      const reattaching = Boolean(tmuxSessionName && this.launched);

      let hookEnv: Record<string, string> = {};
      if (tmuxSessionName) {
        await this.ensureAttachable(session);
        hookEnv = this.hookEnv;
        if (reattaching) {
          // The agent is still running in its tmux pane and its sidecar
          // connection is still open, so re-opening the PTY is all that is left.
          log.info('SshAgentRuntime: re-attaching to running tmux session + sidecar', {
            sessionId: this.sessionId,
          });
        } else {
          const endpoint = this.sidecarEndpoint;
          if (!endpoint) {
            throw new Error(
              'SshAgentRuntime: sidecar reported ready with no endpoint — refusing to launch an agent that cannot reach Switch'
            );
          }
          switchEnv = {
            SWITCH_CONNECTION_ID: await this.openSidecarConnection(endpoint, session.providerId),
          };
        }
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
      this.launched = true;
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
    // On tmux the pane outlives the PTY and a later attach lands back on it, so
    // keep the size — otherwise the re-attach spawns at 80x24 and tmux repaints
    // the pane that small inside a full-width terminal.
    ptySessionRegistry.unregister(this.ptySessionId, { preserveSize: this.tmux });
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
    this.launched = false;
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
