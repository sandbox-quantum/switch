import { HostDependencyManager, type DependencyId } from '@switchdash/core/deps/runtime';
import { clearResolvedPathCache } from '@main/core/agent-runtime/impl/resolve-agent-executable';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { appSettingsService } from '@main/core/settings/settings-service';
import { resolveLocalAutomationShellWithSystemFallback } from '@main/core/terminal-shell/resolver';
import { log } from '@main/lib/logger';
import { agentUpdateService } from './agent-update-service';
import { hostDependencyStore } from './host-dependency-store';
import { createLocalInstallCommandRunner } from './install-runner';
import { DEPENDENCIES, getDependencyDescriptor } from './registry';

async function resolveLocalInstallShellProfile() {
  const { defaultShell } = await appSettingsService.get('terminal');
  return await resolveLocalAutomationShellWithSystemFallback({
    intent: defaultShell,
    onFallback: (error) => {
      log.warn('[DependencyManager] Preferred install shell unavailable, using fallback', {
        shell: error.shell,
        target: error.target,
      });
    },
  });
}

function wireDesktopBridges(manager: HostDependencyManager, connectionId?: string): void {
  // AgentUpdateService owns the enriched event emission (adds latestVersion/updateAvailable)
  agentUpdateService.attach(manager, connectionId);
  manager.onExecutableInvalidated.subscribe(({ id }: { id: DependencyId }) => {
    clearResolvedPathCache(id, connectionId);
  });
}

export const localDependencyManager = new HostDependencyManager(new LocalExecutionContext(), {
  runInstallCommand: createLocalInstallCommandRunner(resolveLocalInstallShellProfile),
  getSelection: (depId) => hostDependencyStore.getSelection('local', depId),
  logger: log,
  dependencies: DEPENDENCIES,
  getDependencyDescriptor,
});
wireDesktopBridges(localDependencyManager, undefined);

export async function getDependencyManager(_connectionId?: string): Promise<HostDependencyManager> {
  return localDependencyManager;
}
