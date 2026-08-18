import { makeAutoObservable, runInAction } from 'mobx';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import type {
  ServerConnectionStatus,
  SwitchAuthConfig,
  SwitchServer,
  UpdateServerResult,
} from '@shared/core/switch-servers/switch-servers';

/**
 * Renderer store for the Switch-server integration. Holds the registered
 * gateways, the per-server connection status (so the sidebar can show a dot per
 * entry), the per-server auth config (which login methods to offer), and which
 * server is active. Managing a server's agents/rooms happens in the gateway web
 * app for now, so this store deliberately does not fetch those — only what the
 * sidebar + the minimal server view need. Modeled on the singleton-store +
 * observable-state pattern used across the renderer stores.
 */
export class SwitchServersStore {
  servers: SwitchServer[] = [];
  activeServerId: string | null = null;

  /** Connection status per server id, refreshed on focus / select / manually. */
  readonly statuses = new Map<string, ServerConnectionStatus>();
  /** Auth config per server id, fetched lazily when a login panel needs it. */
  readonly authConfigs = new Map<string, SwitchAuthConfig>();
  /** Server ids a login panel has asked about. A failed or host-blocked fetch
   * caches nothing, so this is what the recovery paths re-drive. */
  private readonly authConfigWanted = new Set<string>();
  /** Server ids with an auth-config fetch in flight, so several recovery
   * signals arriving at once collapse into a single request. */
  private readonly authConfigInFlight = new Set<string>();
  /** Server ids whose last gateway read failed. The page shows a single
   * "cannot reach" state for these: with the gateway down there is nothing to
   * sign into, so a sign-in form would be a dead end dressed up as a choice. */
  readonly unreachable = new Set<string>();

  loadingServers = false;
  /** Server ids with an in-flight status refresh. */
  readonly refreshing = new Set<string>();
  /** The sentence the page leads with. Never raw exception text. */
  error: string | null = null;
  /** Diagnostics for the same failure, rendered under `error` rather than in it. */
  errorDetail: string | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  /** Headline and detail as one string, for the modals that have a single slot. */
  get errorText(): string | null {
    if (!this.error) return null;
    return this.errorDetail ? `${this.error} (${this.errorDetail})` : this.error;
  }

  /** Whether this server is managed on a host the reachability manager has
   * marked unreachable — nothing it serves can be fetched until that clears. */
  isHostBlocked(serverId: string): boolean {
    const server = this.servers.find((s) => s.id === serverId);
    if (!server?.managed || server.managementKind !== 'remote' || !server.sshHost) return false;
    return hostReachabilityStore.isBlocked(server.sshHost);
  }

  get activeServer(): SwitchServer | null {
    return this.servers.find((s) => s.id === this.activeServerId) ?? null;
  }

  statusFor(serverId: string): ServerConnectionStatus | null {
    return this.statuses.get(serverId) ?? null;
  }

  authConfigFor(serverId: string): SwitchAuthConfig | null {
    return this.authConfigs.get(serverId) ?? null;
  }

  isConnected(serverId: string): boolean {
    return this.statuses.get(serverId)?.connected ?? false;
  }

  /** Whether the last read of this server's gateway failed to reach it. */
  isUnreachable(serverId: string): boolean {
    return this.unreachable.has(serverId);
  }

  async init(): Promise<void> {
    runInAction(() => {
      this.loadingServers = true;
      this.error = null;
      this.errorDetail = null;
    });
    try {
      const [servers, activeServerId] = await Promise.all([
        rpc.switchServers.listServers(),
        rpc.switchServers.getActiveServerId(),
      ]);
      runInAction(() => {
        this.servers = servers;
        this.activeServerId = activeServerId;
      });
      await this.ensureActiveServer();
      await this.refreshAllStatuses();
    } catch (cause) {
      this.setError(cause, 'Could not load your Switch servers.');
    } finally {
      runInAction(() => {
        this.loadingServers = false;
      });
    }
  }

  /**
   * A server is a workspace: the switcher, the sidebar and the sessions under
   * it all read the active one, so one must be selected whenever any server
   * exists. Nothing on the main side picks it — adding the first server leaves
   * the active id null — so every path that changes the list ends here.
   *
   * A stored id that no longer names a server counts as no selection. It is not
   * hypothetical: removing the active server and adding another leaves the id
   * pointing at the removed one, and treating that as a selection left the app
   * with no workspace at all — no switcher, no sidebar tree, no way back.
   */
  private async ensureActiveServer(): Promise<void> {
    if (this.activeServerId && this.servers.some((s) => s.id === this.activeServerId)) return;
    const first = this.servers[0];
    if (first) await this.setActive(first.id);
  }

  async refreshAllStatuses(): Promise<void> {
    await Promise.all(this.servers.map((s) => this.refreshStatus(s.id)));
  }

  /**
   * Re-drive everything that recovers when connectivity does: the connection
   * status of every server, plus any auth config a login panel is still waiting
   * on. Auth config only recovers if something asks again, so it has to ride
   * the same signals as status rather than being a once-per-mount read.
   *
   * Only servers a login panel actually asked about are re-fetched, so this
   * stays as cheap as the status sweep it accompanies.
   */
  async recoverStale(): Promise<void> {
    const pending = [...this.authConfigWanted].filter((id) => !this.authConfigs.has(id));
    await Promise.all([
      this.refreshAllStatuses(),
      ...pending.map((id) => this.ensureAuthConfig(id)),
    ]);
  }

  /**
   * The server page's manual re-check. Covers both what the status card reads
   * and what the sign-in panel needs — refreshing only the status leaves a page
   * that never got its auth config stuck on "Checking sign-in options…".
   */
  async refreshServer(serverId: string): Promise<void> {
    await Promise.all([this.refreshStatus(serverId), this.ensureAuthConfig(serverId)]);
  }

  async refreshStatus(serverId: string): Promise<void> {
    runInAction(() => {
      this.refreshing.add(serverId);
    });
    try {
      const status = await rpc.switchServers.getConnectionStatus(serverId);
      runInAction(() => {
        this.statuses.set(serverId, status);
        this.unreachable.delete(serverId);
      });
    } catch (cause) {
      // An unreachable server is a real, displayable state — record it as
      // disconnected (the per-server status dot shows it) and flag the server
      // so its page can say so in one line. A background poll failure must NOT
      // raise the page-level `error` banner: that field is global, so one
      // unreachable server would paint an error over every server's view.
      console.warn(`[switch-servers] could not read status for ${serverId}`, cause);
      runInAction(() => {
        this.statuses.set(serverId, { serverId, connected: false, user: null });
        this.unreachable.add(serverId);
      });
    } finally {
      runInAction(() => {
        this.refreshing.delete(serverId);
      });
    }
  }

  /**
   * Fetch which login methods a server offers, unless that is already known.
   *
   * Safe to call from every recovery path: a cached config short-circuits, and
   * concurrent callers collapse into the one in-flight request. A failure
   * caches nothing, so the next caller retries — which is the point, since the
   * usual failure is a connectivity blip that later heals (CHOO-2042).
   */
  async ensureAuthConfig(serverId: string): Promise<void> {
    runInAction(() => {
      this.authConfigWanted.add(serverId);
    });
    if (this.authConfigs.has(serverId)) return;
    if (this.authConfigInFlight.has(serverId)) return;
    // The gateway of a server on an unreachable host cannot answer, and the
    // host-unreachable surface already states why — don't paint the global
    // error banner with a doomed fetch (CHOO-1780). The host un-blocking is
    // itself a recovery signal, so this is a skip, not a giving up.
    if (this.isHostBlocked(serverId)) return;
    runInAction(() => {
      this.authConfigInFlight.add(serverId);
    });
    try {
      const config = await rpc.switchServers.getAuthConfig(serverId);
      runInAction(() => {
        this.authConfigs.set(serverId, config);
        this.unreachable.delete(serverId);
      });
    } catch (cause) {
      // Not the error banner: the raw text is our own IPC method name wrapped
      // around a fetch failure, which tells the user nothing they can act on.
      // The page states the one thing that matters, that the server cannot be
      // reached, and the detail stays in the console for us.
      console.warn(`[switch-servers] could not read auth config for ${serverId}`, cause);
      runInAction(() => {
        this.unreachable.add(serverId);
      });
    } finally {
      runInAction(() => {
        this.authConfigInFlight.delete(serverId);
      });
    }
  }

  async addServer(name: string, gatewayUrl: string, apiUrl: string): Promise<SwitchServer | null> {
    this.clearError();
    try {
      const created = await rpc.switchServers.addServer({ name, gatewayUrl, apiUrl });
      const [servers, activeServerId] = await Promise.all([
        rpc.switchServers.listServers(),
        rpc.switchServers.getActiveServerId(),
      ]);
      runInAction(() => {
        this.servers = servers;
        this.activeServerId = activeServerId;
      });
      await this.ensureActiveServer();
      await this.refreshStatus(created.id);
      return created;
    } catch (cause) {
      this.setError(cause, 'Could not add the server.');
      return null;
    }
  }

  async updateServer(
    id: string,
    name: string,
    gatewayUrl: string,
    apiUrl: string
  ): Promise<UpdateServerResult | null> {
    this.clearError();
    try {
      const result = await rpc.switchServers.updateServer({ id, name, gatewayUrl, apiUrl });
      const servers = await rpc.switchServers.listServers();
      runInAction(() => {
        this.servers = servers;
      });
      return result;
    } catch (cause) {
      this.setError(cause, 'Could not save the server.');
      return null;
    }
  }

  async renameServer(id: string, name: string): Promise<boolean> {
    this.clearError();
    try {
      await rpc.switchServers.renameServer({ id, name });
      const servers = await rpc.switchServers.listServers();
      runInAction(() => {
        this.servers = servers;
      });
      return true;
    } catch (cause) {
      this.setError(cause, 'Could not rename the server.');
      return false;
    }
  }

  /**
   * Delete a server. For a managed server this first tears down its stack (the
   * Docker/SSH reset — stops containers and destroys the stack's data), since
   * removing the record while the stack keeps running would strand it. That
   * teardown also deletes the stack's agents, whose identity it destroys.
   *
   * External servers have no stack: de-registering one destroys nothing, so its
   * agents keep working and are merely unlinked (see {@link removeServer}).
   * Returns false if the teardown or de-register failed.
   */
  async deleteServer(serverId: string): Promise<boolean> {
    this.clearError();
    const server = this.servers.find((s) => s.id === serverId);
    try {
      if (server?.managed) {
        if (server.managementKind === 'remote' && server.sshHost) {
          await rpc.remoteSwitchServer.reset(server.sshHost);
        } else {
          await rpc.localSwitchServer.reset();
        }
      }
    } catch (cause) {
      this.setError(cause, 'Could not shut down the server’s stack, so it was not deleted.');
      return false;
    }
    await this.removeServer(serverId);
    return this.error === null;
  }

  async removeServer(serverId: string): Promise<void> {
    this.clearError();
    try {
      await rpc.switchServers.removeServer(serverId);
      const [servers, activeServerId] = await Promise.all([
        rpc.switchServers.listServers(),
        rpc.switchServers.getActiveServerId(),
      ]);
      runInAction(() => {
        this.servers = servers;
        this.activeServerId = activeServerId;
        this.statuses.delete(serverId);
        this.authConfigs.delete(serverId);
        this.authConfigWanted.delete(serverId);
        this.unreachable.delete(serverId);
      });
      await this.ensureActiveServer();
    } catch (cause) {
      this.setError(cause, 'Could not remove the server.');
    }
  }

  async setActive(serverId: string): Promise<void> {
    this.clearError();
    try {
      await rpc.switchServers.setActiveServer(serverId);
      runInAction(() => {
        this.activeServerId = serverId;
      });
    } catch (cause) {
      this.setError(cause, 'Could not switch to that server.');
    }
  }

  async passwordLogin(serverId: string, email: string, password: string): Promise<boolean> {
    this.clearError();
    const result = await rpc.switchServers.passwordLogin({ serverId, email, password });
    if (!result.success) {
      runInAction(() => {
        this.error = result.error.message;
        this.errorDetail = null;
      });
      return false;
    }
    await this.refreshStatus(serverId);
    return true;
  }

  async oidcLogin(serverId: string): Promise<boolean> {
    this.clearError();
    const result = await rpc.switchServers.oidcLogin(serverId);
    if (!result.success) {
      // A user-cancelled window is not an error worth shouting about.
      if (result.error.kind !== 'cancelled') {
        runInAction(() => {
          this.error = result.error.message;
          this.errorDetail = null;
        });
      }
      return false;
    }
    await this.refreshStatus(serverId);
    return true;
  }

  async logout(serverId: string): Promise<void> {
    this.clearError();
    try {
      await rpc.switchServers.logout(serverId);
      await this.refreshStatus(serverId);
    } catch (cause) {
      this.setError(cause, 'Could not sign out of the server.');
    }
  }

  private clearError(): void {
    runInAction(() => {
      this.error = null;
      this.errorDetail = null;
    });
  }

  /**
   * `error` is rendered directly in banners and modals, so it goes through the
   * shared boundary rather than carrying whatever was thrown. The fallback is
   * per-action: the store knows which request failed, and the failure itself
   * usually does not.
   */
  private setError(cause: unknown, fallback: string): void {
    const { headline, detail } = describeFailure(cause, fallback);
    runInAction(() => {
      this.error = headline;
      this.errorDetail = detail;
    });
  }
}

export const switchServersStore = new SwitchServersStore();
