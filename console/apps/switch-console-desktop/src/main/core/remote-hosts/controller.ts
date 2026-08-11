import type { InstallMethod } from '@switch-console/core/deps';
import type {
  DependencyCategory,
  DependencyInstallResult,
  DependencyStatus,
  DependencyUninstallResult,
  DependencyUpdateResult,
} from '@switch-console/core/deps/runtime';
import { detectSwitchAgentRemote } from '@main/core/agents/detect-remote';
import {
  evictRemoteDependencyManager,
  getRemoteDependencyManager,
  remoteDependencyDescriptor,
} from '@main/core/dependencies/remote-dependency-manager';
import { getRemoteSwitchSetupService } from '@main/core/switch-setup/remote-switch-setup';
import { hostBlockedReason, type HostReachability } from '@shared/core/remote-hosts/reachability';
import type { HostSetupPlan } from '@shared/core/remote-hosts/setup';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type { SwitchAgentConfig } from '@shared/switch-agents';
import { listSshConfigHosts } from './list-ssh-config-hosts';
import { hostReachabilityService } from './production-host-reachability';
import { deletePersistedReachability } from './reachability-store';
import {
  discardSetupPlan,
  ensureSetupPlan,
  installSetupStep,
  readAllSetupPlans,
  readSetupPlan,
  recheckSetup,
  recheckSetupStep,
  skipSetupStep,
  updateSetupStep,
} from './setup/host-setup-service';
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
  /** True when Switch Console has an install command for this host's platform. */
  canInstall: boolean;
};

export type TestConnectionResult = { ok: true } | { ok: false; message: string };

/**
 * Ad-hoc reachability check. Routed through the reachability service rather
 * than connecting directly, so a manual "Test connection" and the background
 * probe share one code path — and a successful test immediately un-pauses the
 * host-dependent work that was gated on the old state.
 */
async function testConnection(sshHost: string): Promise<TestConnectionResult> {
  const reachability = await hostReachabilityService.checkNow(sshHost);
  if (reachability.status === 'reachable') return { ok: true };
  return { ok: false, message: reachability.lastError ?? hostBlockedReason(reachability) };
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

  return views;
}

export const remoteHostsController = createRPCController({
  /** SSH aliases from ~/.ssh/config, for the onboarding picker. */
  listSshConfigHosts: (): Promise<string[]> => listSshConfigHosts(),

  /** Onboarded remote hosts. */
  listHosts: (): Promise<RemoteHost[]> => listRemoteHosts(),

  testConnection: (sshHost: string): Promise<TestConnectionResult> => testConnection(sshHost),

  /** Modeled reachability for one host — the state the UI gates its display on. */
  getReachability: (sshHost: string): Promise<HostReachability> =>
    Promise.resolve(hostReachabilityService.get(sshHost)),

  /** Every host the reachability model knows about, for the initial UI hydrate. */
  listReachability: (): Promise<HostReachability[]> =>
    Promise.resolve(hostReachabilityService.getAll()),

  /**
   * Probe now, bypassing the backoff — the "Retry connection" button. On
   * success this clears the blocked state, which resumes every paused
   * host-dependent path (reconciler included) rather than only fixing the
   * screen the user is looking at.
   */
  retryHost: (sshHost: string): Promise<HostReachability> =>
    hostReachabilityService.checkNow(sshHost),

  /** Verify reachability, then onboard (or rename) the host. */
  onboardHost: async (params: { sshHost: string; name: string }): Promise<RemoteHost> => {
    const test = await testConnection(params.sshHost);
    if (!test.ok) {
      throw new Error(`Cannot reach ${params.sshHost}: ${test.message}`);
    }
    return upsertRemoteHost({ sshHost: params.sshHost, name: params.name });
  },

  /**
   * Remove a host and everything keyed to it. Previously only the row was
   * deleted, leaving an orphaned reachability record and a cached dependency
   * manager bound to the old connection — so re-adding the same alias resumed
   * against stale state.
   */
  removeHost: async (sshHost: string): Promise<void> => {
    await removeRemoteHost(sshHost);
    await discardSetupPlan(sshHost);
    await deletePersistedReachability(sshHost);
    evictRemoteDependencyManager(sshHost);
  },

  /** The host's persisted setup plan, or null if setup has never been run. */
  getSetupPlan: (sshHost: string): Promise<HostSetupPlan | null> => readSetupPlan(sshHost),

  /** Every host's plan, for the initial hydrate of the renderer's readiness store. */
  listSetupPlans: (): Promise<HostSetupPlan[]> => readAllSetupPlans(),

  /**
   * Build or refresh the plan without running it — what the host page loads on
   * open. Merges onto any persisted progress rather than discarding it.
   * Structural only: it lists what to check, it does not check it.
   */
  prepareSetup: (sshHost: string): Promise<HostSetupPlan> => ensureSetupPlan(sshHost),

  /** Probe every step and install nothing — the "Re-check" button. */
  recheckSetup: (sshHost: string): Promise<HostSetupPlan> => recheckSetup(sshHost),

  /** Re-observe one prerequisite or agent type, installing nothing. */
  recheckSetupStep: (params: { sshHost: string; stepId: string }): Promise<HostSetupPlan> =>
    recheckSetupStep(params.sshHost, params.stepId),

  /** Install one prerequisite or agent type on its own, then verify it. */
  installSetupStep: (params: { sshHost: string; stepId: string }): Promise<HostSetupPlan> =>
    installSetupStep(params.sshHost, params.stepId),

  /** Replace one prerequisite or agent type with its newest version, then verify. */
  updateSetupStep: (params: { sshHost: string; stepId: string }): Promise<HostSetupPlan> =>
    updateSetupStep(params.sshHost, params.stepId),

  /** Move past a step the user has chosen not to fix, unblocking the rest. */
  skipSetupStep: (params: { sshHost: string; stepId: string }): Promise<HostSetupPlan> =>
    skipSetupStep(params.sshHost, params.stepId),

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
