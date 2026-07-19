import { makeAutoObservable, runInAction } from 'mobx';
import { rpc } from '@renderer/lib/ipc';
import type {
  ServerConnectionStatus,
  SwitchAuthConfig,
  SwitchServer,
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

  loadingServers = false;
  /** Server ids with an in-flight status refresh. */
  readonly refreshing = new Set<string>();
  error: string | null = null;
  /** Whether the sidebar "Servers" section is expanded. */
  serversExpanded = true;

  constructor() {
    makeAutoObservable(this);
  }

  get activeServer(): SwitchServer | null {
    return this.servers.find((s) => s.id === this.activeServerId) ?? null;
  }

  toggleServersExpanded(): void {
    this.serversExpanded = !this.serversExpanded;
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

  async init(): Promise<void> {
    runInAction(() => {
      this.loadingServers = true;
      this.error = null;
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
      // The sidebar scopes its whole view to the active server, so one must
      // always be selected when any server exists. Default to the first.
      if (!this.activeServerId && servers.length > 0) {
        await this.setActive(servers[0].id);
      }
      await this.refreshAllStatuses();
    } catch (cause) {
      this.setError(cause);
    } finally {
      runInAction(() => {
        this.loadingServers = false;
      });
    }
  }

  async refreshAllStatuses(): Promise<void> {
    await Promise.all(this.servers.map((s) => this.refreshStatus(s.id)));
  }

  async refreshStatus(serverId: string): Promise<void> {
    runInAction(() => {
      this.refreshing.add(serverId);
    });
    try {
      const status = await rpc.switchServers.getConnectionStatus(serverId);
      runInAction(() => {
        this.statuses.set(serverId, status);
      });
    } catch {
      // An unreachable server is a real, displayable state — record it as
      // disconnected (the per-server status dot shows it). A background poll
      // failure must NOT raise the page-level `error` banner: that field is
      // global, so one unreachable server would paint an error over every
      // server's view.
      runInAction(() => {
        this.statuses.set(serverId, { serverId, connected: false, user: null });
      });
    } finally {
      runInAction(() => {
        this.refreshing.delete(serverId);
      });
    }
  }

  async ensureAuthConfig(serverId: string): Promise<void> {
    if (this.authConfigs.has(serverId)) return;
    try {
      const config = await rpc.switchServers.getAuthConfig(serverId);
      runInAction(() => {
        this.authConfigs.set(serverId, config);
      });
    } catch (cause) {
      this.setError(cause);
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
      await this.refreshStatus(created.id);
      return created;
    } catch (cause) {
      this.setError(cause);
      return null;
    }
  }

  async updateServer(
    id: string,
    name: string,
    gatewayUrl: string,
    apiUrl: string
  ): Promise<SwitchServer | null> {
    this.clearError();
    try {
      const updated = await rpc.switchServers.updateServer({ id, name, gatewayUrl, apiUrl });
      const servers = await rpc.switchServers.listServers();
      runInAction(() => {
        this.servers = servers;
      });
      return updated;
    } catch (cause) {
      this.setError(cause);
      return null;
    }
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
      });
      // Keep a server scoped when any remain (the sidebar scopes to it).
      if (!this.activeServerId && servers.length > 0) {
        await this.setActive(servers[0].id);
      }
    } catch (cause) {
      this.setError(cause);
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
      this.setError(cause);
    }
  }

  async passwordLogin(serverId: string, email: string, password: string): Promise<boolean> {
    this.clearError();
    const result = await rpc.switchServers.passwordLogin({ serverId, email, password });
    if (!result.success) {
      runInAction(() => {
        this.error = result.error.message;
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
      this.setError(cause);
    }
  }

  private clearError(): void {
    runInAction(() => {
      this.error = null;
    });
  }

  private setError(cause: unknown): void {
    runInAction(() => {
      this.error = cause instanceof Error ? cause.message : String(cause);
    });
  }
}

export const switchServersStore = new SwitchServersStore();
