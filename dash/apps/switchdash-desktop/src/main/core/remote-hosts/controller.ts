import type { InstallMethod } from '@switchdash/core/deps';
import type {
  DependencyCategory,
  DependencyInstallResult,
  DependencyStatus,
  DependencyUninstallResult,
  DependencyUpdateResult,
} from '@switchdash/core/deps/runtime';
import { isTransportFailure } from '@switchdash/core/exec';
import { detectSwitchAgentRemote } from '@main/core/agents/detect-remote';
import {
  getRemoteDependencyManager,
  remoteDependencyDescriptor,
} from '@main/core/dependencies/remote-dependency-manager';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import { openSsh2Pty } from '@main/core/pty/ssh2-pty';
import { ensureSshConnected, forceSshReconnect } from '@main/core/ssh/connect/connect-agent-ssh';
import { sshConnectionManager } from '@main/core/ssh/lifecycle/production-ssh-connection-manager';
import { buildRemoteShellCommand } from '@main/core/ssh/lifecycle/remote-shell-profile';
import {
  getRemoteSwitchSetupService,
  type RemoteSwitchSetupService,
} from '@main/core/switch-setup/remote-switch-setup';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import type { ConnectionState, SshHealthState } from '@shared/core/ssh/ssh';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type { SwitchAgentConfig } from '@shared/switch-agents';
import { listSshConfigHosts } from './list-ssh-config-hosts';
import { listRemoteHosts, removeRemoteHost, upsertRemoteHost, type RemoteHost } from './store';

/** A single dependency's status on a remote host, enriched for the UI. */
export type RemoteDependencyView = {
  id: string;
  name: string;
  category: DependencyCategory;
  status: DependencyStatus;
  version: string | null;
  path: string | null;
  error?: string;
  docUrl?: string;
  /** True when switchdash has an install command for this host's platform. */
  canInstall: boolean;
  /**
   * GitHub CLI auth status. Present only on the `gh` dependency once its binary
   * is available — `gh` being installed is not enough to use it, it must also be
   * authenticated (`gh auth status`).
   */
  ghAuth?: GhAuthStatus;
};

export type GhAuthStatus = { authenticated: boolean; account: string | null };

export type TestConnectionResult = { ok: true } | { ok: false; message: string };

/** Live status of a host's pooled SSH connection, for the connection badge. */
export type HostConnectionStatus = {
  state: ConnectionState;
  health: SshHealthState;
};

function hostConnectionStatus(sshHost: string): HostConnectionStatus {
  const connectionId = sshConnectionIdForHost(sshHost);
  return {
    state: sshConnectionManager.getConnectionState(connectionId),
    health: sshConnectionManager.getAllHealthStates()[connectionId] ?? { status: 'ok' },
  };
}

/** Matches the account line of `gh auth status` across gh versions ("account NAME" / "as NAME"). */
const GH_AUTH_ACCOUNT_RE = /Logged in to \S+ (?:account|as) (\S+)/;

/**
 * Check whether `gh` is authenticated on a remote host via `gh auth status`.
 * Exit 0 means authenticated; a non-zero exit (which SshExecutionContext
 * throws on) means not logged in. A transport failure propagates — a dead
 * connection is not evidence of a missing login.
 */
async function probeGhAuth(sshHost: string): Promise<GhAuthStatus> {
  const proxy = await ensureSshConnected(sshConnectionIdForHost(sshHost), sshHost);
  const ctx = new SshExecutionContext(proxy);
  try {
    const { stdout, stderr } = await ctx.exec('gh', ['auth', 'status']);
    const account = GH_AUTH_ACCOUNT_RE.exec(`${stdout}\n${stderr}`)?.[1] ?? null;
    return { authenticated: true, account };
  } catch (error) {
    if (isTransportFailure(error)) throw error;
    return { authenticated: false, account: null };
  }
}

async function testConnection(sshHost: string): Promise<TestConnectionResult> {
  try {
    const proxy = await ensureSshConnected(sshConnectionIdForHost(sshHost), sshHost);
    const ctx = new SshExecutionContext(proxy);
    await ctx.exec('uname', ['-s']);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function probeDeps(sshHost: string): Promise<RemoteDependencyView[]> {
  const manager = await getRemoteDependencyManager(sshHost);
  await manager.probeAll();
  const views = [...manager.getAll().values()].map((state): RemoteDependencyView => {
    const descriptor = remoteDependencyDescriptor(state.id);
    return {
      id: state.id,
      name: descriptor?.name ?? state.id,
      category: state.category,
      status: state.status,
      version: state.version,
      path: state.path,
      error: state.error,
      docUrl: descriptor?.docUrl,
      canInstall: manager.getInstallOptions(state.id).length > 0,
    };
  });

  // gh being installed is not enough — it must also be authenticated. Only probe
  // auth when the binary is present (probing gh auth without gh would just fail).
  const gh = views.find((v) => v.id === 'gh');
  if (gh && gh.status === 'available') {
    gh.ghAuth = await probeGhAuth(sshHost);
  }

  return views;
}

/**
 * Whether a remote host is set up enough to run Switch agents, and which agent
 * types are actually usable on it. A host is `ready` when its core tooling is in
 * place (git, tmux, node installed and gh authenticated) AND at least one agent
 * type has BOTH its CLI and the Switch connector plugin installed.
 */
export type HostSetupStatus = {
  sshHost: string;
  reachable: boolean;
  coreReady: boolean;
  /** Agent-type ids with both CLI and Switch plugin installed on this host. */
  availableAgentIds: string[];
  ready: boolean;
  /** Human-readable outstanding items, for surfacing why a host isn't ready. */
  issues: string[];
};

async function getHostSetup(sshHost: string): Promise<HostSetupStatus> {
  let views: RemoteDependencyView[];
  let plugins: Awaited<ReturnType<RemoteSwitchSetupService['listAgentTypeStatuses']>>;
  try {
    views = await probeDeps(sshHost);
    const service = await getRemoteSwitchSetupService(sshHost);
    plugins = await service.listAgentTypeStatuses();
  } catch (error) {
    return {
      sshHost,
      reachable: false,
      coreReady: false,
      availableAgentIds: [],
      ready: false,
      issues: [error instanceof Error ? error.message : 'Host unreachable'],
    };
  }

  const issues: string[] = [];
  for (const dep of views.filter((v) => v.category === 'core')) {
    if (dep.id === 'gh') {
      if (dep.status !== 'available') issues.push('GitHub CLI not installed');
      else if (dep.ghAuth && !dep.ghAuth.authenticated) issues.push('GitHub CLI not authenticated');
    } else if (dep.status !== 'available') {
      issues.push(`${dep.name} not installed`);
    }
  }
  const coreReady = issues.length === 0;

  // An agent is usable only with BOTH its CLI and the Switch plugin present.
  const cliInstalled = new Set(
    views.filter((v) => v.category === 'agent' && v.status === 'available').map((v) => v.id)
  );
  const availableAgentIds = plugins
    .filter((p) => p.supported && p.installed && cliInstalled.has(p.agentId))
    .map((p) => p.agentId);

  if (availableAgentIds.length === 0) {
    issues.push('No agent type has both its CLI and the Switch plugin installed');
  }

  return {
    sshHost,
    reachable: true,
    coreReady,
    availableAgentIds,
    ready: coreReady && availableAgentIds.length > 0,
    issues,
  };
}

/**
 * Start an interactive `gh auth login` device-flow session on a remote host over
 * SSH. Runs in a PTY registered with the shared PtySessionRegistry so the renderer
 * can attach a live terminal (subscribe to output, send keystrokes) via the pty
 * RPC/events. gh prints a one-time code and a verification URL; the user opens the
 * URL in their own browser and enters the code. Returns the PTY session id.
 */
async function startGhAuth(sshHost: string): Promise<{ sessionId: string }> {
  const proxy = await ensureSshConnected(sshConnectionIdForHost(sshHost), sshHost);
  const profile = await proxy.getRemoteShellProfile();
  const remoteCommand = buildRemoteShellCommand(
    profile,
    'gh auth login --hostname github.com --git-protocol https --web'
  );
  const sessionId = `gh-auth:${crypto.randomUUID()}`;

  const opened = await openSsh2Pty(proxy, {
    id: sessionId,
    command: remoteCommand,
    cols: 80,
    rows: 24,
  });
  if (!opened.success) {
    throw new Error(`Could not start gh auth on ${sshHost}: ${opened.error.message}`);
  }

  ptySessionRegistry.register(sessionId, opened.data, {
    metadata: { title: `gh auth login (${sshHost})`, isRemote: true },
  });
  return { sessionId };
}

export const remoteHostsController = createRPCController({
  /** SSH aliases from ~/.ssh/config, for the onboarding picker. */
  listSshConfigHosts: (): Promise<string[]> => listSshConfigHosts(),

  /** Onboarded remote hosts. */
  listHosts: (): Promise<RemoteHost[]> => listRemoteHosts(),

  testConnection: (sshHost: string): Promise<TestConnectionResult> => testConnection(sshHost),

  /** Live state + health of the host's pooled SSH connection. */
  getConnectionStatus: (sshHost: string): Promise<HostConnectionStatus> =>
    Promise.resolve(hostConnectionStatus(sshHost)),

  /**
   * Force a full transport rebuild for the host's pooled connection — the
   * manual recovery path for a wedged or given-up connection. Returns the
   * post-rebuild status.
   */
  reconnectHost: async (sshHost: string): Promise<HostConnectionStatus> => {
    await forceSshReconnect(sshConnectionIdForHost(sshHost), sshHost);
    return hostConnectionStatus(sshHost);
  },

  /** Verify reachability, then onboard (or rename) the host. */
  onboardHost: async (params: { sshHost: string; name: string }): Promise<RemoteHost> => {
    const test = await testConnection(params.sshHost);
    if (!test.ok) {
      throw new Error(`Cannot reach ${params.sshHost}: ${test.message}`);
    }
    return upsertRemoteHost({ sshHost: params.sshHost, name: params.name });
  },

  removeHost: (sshHost: string): Promise<void> => removeRemoteHost(sshHost),

  /**
   * Detect the Switch agent configured in a remote working directory (reads its
   * `.claude/settings.local.json` over SSH). Used by the add-agent modal to
   * detect + server-verify a remote agent without any local directory.
   */
  detectRemoteAgent: (params: {
    sshHost: string;
    remoteRepoDir: string;
  }): Promise<SwitchAgentConfig | null> =>
    detectSwitchAgentRemote(params.sshHost, params.remoteRepoDir),

  probeDeps: (sshHost: string): Promise<RemoteDependencyView[]> => probeDeps(sshHost),

  /** Whether a host is set up to run agents, and which agent types are usable on it. */
  getHostSetup: (sshHost: string): Promise<HostSetupStatus> => getHostSetup(sshHost),

  /** Begin an interactive `gh auth login` PTY session on the host; returns its pty session id. */
  startGhAuth: (params: { sshHost: string }): Promise<{ sessionId: string }> =>
    startGhAuth(params.sshHost),

  installDep: async (params: {
    sshHost: string;
    id: string;
    method?: InstallMethod;
  }): Promise<DependencyInstallResult> => {
    const manager = await getRemoteDependencyManager(params.sshHost);
    return manager.install(params.id, params.method);
  },

  updateDep: async (params: { sshHost: string; id: string }): Promise<DependencyUpdateResult> => {
    const manager = await getRemoteDependencyManager(params.sshHost);
    return manager.update(params.id);
  },

  uninstallDep: async (params: {
    sshHost: string;
    id: string;
  }): Promise<DependencyUninstallResult> => {
    const manager = await getRemoteDependencyManager(params.sshHost);
    return manager.uninstall(params.id);
  },

  /** Switch connector plugin status for every Switch-supported agent type on the host. */
  listAgentTypePlugins: async (sshHost: string) => {
    const service = await getRemoteSwitchSetupService(sshHost);
    return service.listAgentTypeStatuses();
  },

  checkAgentPluginUpdates: async (params: { sshHost: string; agentId: string }) => {
    const service = await getRemoteSwitchSetupService(params.sshHost);
    return service.checkForUpdates(params.agentId);
  },

  installAgentPlugin: async (params: { sshHost: string; agentId: string }) => {
    const service = await getRemoteSwitchSetupService(params.sshHost);
    return service.install(params.agentId);
  },

  updateAgentPlugin: async (params: { sshHost: string; agentId: string }) => {
    const service = await getRemoteSwitchSetupService(params.sshHost);
    return service.update(params.agentId);
  },
});
