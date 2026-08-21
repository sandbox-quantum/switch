import type { InstallMethod } from '@switch-console/core/deps';
import type {
  DependencyId,
  DependencyProbeOptions,
  HostDependencySelection,
  InstallOverride,
} from '@switch-console/core/deps/runtime';
import { agentTypeOf } from '@main/core/telemetry/agent-type';
import { cliFailureReason } from '@main/core/telemetry/cli-failure';
import type { TelemetryCliAction } from '@main/core/telemetry/events';
import { trackEvent } from '@main/core/telemetry/telemetry-service';
import type { ProviderCustomConfig } from '@shared/core/app-settings';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { clearResolvedPathCache } from '../agent-runtime/impl/resolve-agent-executable';
import { agentUpdateService } from '../dependencies/agent-update-service';
import { getDependencyManager } from '../dependencies/dependency-managers';
import { hostDependencyStore } from '../dependencies/host-dependency-store';
import { providerOverrideSettings } from '../settings/provider-settings-service';
import {
  buildAgentMetadataList,
  buildAgentPayload,
  buildAgentPayloads,
  toAgentInstallationStatus,
} from './agent-payload-builder';

/** Enrich a manager HostDependency snapshot with latestVersion/updateAvailable from the coordinator. */
const enrichHostDep = (
  id: DependencyId,
  hostDep: Parameters<typeof agentUpdateService.enrichHostDependency>[1]
) => agentUpdateService.enrichHostDependency(id, hostDep);

/**
 * Report installing, updating or removing an agent's CLI.
 *
 * `target` is always local here. This controller accepts a connection id and
 * discards it — `getDependencyManager` returns the local manager whatever it is
 * given — so nothing reached through it runs anywhere else. The genuinely remote
 * equivalents live on the remote-hosts controller and report themselves.
 */
function reportCliAction(
  action: TelemetryCliAction,
  id: string,
  method: InstallMethod | undefined,
  result: { success: boolean; error?: { type?: string } }
): void {
  trackEvent('agent_cli_action', {
    agent_type: agentTypeOf(id),
    target: 'local',
    install_method: method ?? 'unspecified',
    action,
    outcome: result.success ? 'success' : 'failure',
    failure_reason: cliFailureReason(result),
  });
}

export const providersController = createRPCController({
  // ── Metadata ────────────────────────────────────────────────────────────────

  list: async (connectionId?: string) => {
    const mgr = await getDependencyManager(connectionId);
    return buildAgentPayloads(mgr.platform, mgr, enrichHostDep);
  },

  get: async (id: string, connectionId?: string) => {
    const mgr = await getDependencyManager(connectionId);
    return buildAgentPayload(id, mgr.platform, mgr, enrichHostDep);
  },

  // ── Installation status ──────────────────────────────────────────────────────

  listAgentInstallationStatus: async (connectionId?: string) => {
    const mgr = await getDependencyManager(connectionId);
    return Array.from(mgr.getAll().values())
      .filter((s) => s.category === 'agent')
      .map((state) => {
        const rawHostDep = mgr.getHostDependency(state.id as DependencyId);
        const hostDep = rawHostDep
          ? agentUpdateService.enrichHostDependency(state.id as DependencyId, rawHostDep)
          : undefined;
        return toAgentInstallationStatus(state.id, connectionId, state, hostDep);
      });
  },

  getAgentInstallationStatus: async (id: string, connectionId?: string) => {
    const mgr = await getDependencyManager(connectionId);
    const state = mgr.get(id as DependencyId);
    if (!state) return null;
    const rawHostDep = mgr.getHostDependency(id as DependencyId);
    const hostDep = rawHostDep
      ? agentUpdateService.enrichHostDependency(id as DependencyId, rawHostDep)
      : undefined;
    return toAgentInstallationStatus(id, connectionId, state, hostDep);
  },

  // ── Install / update ─────────────────────────────────────────────────────────

  install: async (id: AgentProviderId, connectionId?: string, method?: InstallMethod) => {
    const mgr = await getDependencyManager(connectionId);
    const result = await mgr.install(id, method);
    reportCliAction('install', id, method, result);
    if (result.success) {
      // Persist the chosen method as an override, or clear to auto when no method was chosen.
      // Do NOT auto-promote the inferred method — that would freeze a heuristic guess.
      const override: InstallOverride | null = method ? { kind: 'method', method } : null;
      await hostDependencyStore.setSelection(connectionId ?? 'local', id, override);
      clearResolvedPathCache(id, connectionId);
    }
    return result;
  },

  update: async (id: AgentProviderId, connectionId?: string, method?: InstallMethod) => {
    const mgr = await getDependencyManager(connectionId);
    const result = await mgr.update(id, method);
    reportCliAction('update', id, method, result);
    return result;
  },

  uninstall: async (id: AgentProviderId, connectionId?: string, method?: InstallMethod) => {
    const mgr = await getDependencyManager(connectionId);
    const result = await mgr.uninstall(id, method);
    reportCliAction('uninstall', id, method, result);
    return result;
  },

  // ── Settings ─────────────────────────────────────────────────────────────────

  getDefaultSettings: async (id: string): Promise<ProviderCustomConfig | null> => {
    const meta = await providerOverrideSettings.getItemWithMeta(id);
    return meta?.defaults ?? null;
  },

  getSettings: async (id: string) => {
    return providerOverrideSettings.getItemWithMeta(id);
  },

  updateSettings: (id: string, config: Partial<ProviderCustomConfig>): Promise<void> =>
    providerOverrideSettings.updateItem(id, config),

  // ── Selection + probe ────────────────────────────────────────────────────────

  setUsedInstallation: async (
    id: DependencyId,
    connectionId?: string,
    selection?: HostDependencySelection
  ): Promise<void> => {
    // undefined = no-op; null = explicit auto (clear override)
    if (selection === undefined) return;
    await hostDependencyStore.setSelection(connectionId ?? 'local', id, selection);
    clearResolvedPathCache(id, connectionId);
    const mgr = await getDependencyManager(connectionId);
    await mgr.probe(id);
  },

  refreshLatestVersion: async (id: DependencyId, connectionId?: string): Promise<void> => {
    await agentUpdateService.refreshLatestVersion(id, connectionId);
  },

  probe: async (id: DependencyId, connectionId?: string) => {
    const mgr = await getDependencyManager(connectionId);
    return mgr.probe(id);
  },

  probeOverride: async (
    id: DependencyId,
    selection: { path?: string; cli?: string },
    connectionId?: string
  ) => {
    const mgr = await getDependencyManager(connectionId);
    return mgr.probeOverride(id, selection);
  },

  probeAll: async (connectionId?: string, options?: DependencyProbeOptions) => {
    const mgr = await getDependencyManager(connectionId);
    return mgr.probeAll(options);
  },

  listMetadata: async () => {
    return buildAgentMetadataList();
  },
});
