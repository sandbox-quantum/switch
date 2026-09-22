import { HostDependencyManager, type DependencyId } from '@switch-console/core/deps/runtime';
import { clearResolvedPathCache } from '@main/core/agent-runtime/impl/resolve-agent-executable';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { resolveLocalAutomationShellWithSystemFallback } from '@main/core/terminal-shell/resolver';
import { log } from '@main/lib/logger';
import { agentUpdateService } from './agent-update-service';
import { hostDependencyStore } from './host-dependency-store';
import { createLocalInstallCommandRunner } from './install-runner';
import { DEPENDENCIES, getDependencyDescriptor } from './registry';

async function resolveLocalInstallShellProfile() {
  return await resolveLocalAutomationShellWithSystemFallback({
    intent: 'system',
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
