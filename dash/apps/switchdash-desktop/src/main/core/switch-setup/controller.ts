import { hostReachabilityService } from '@main/core/remote-hosts/production-host-reachability';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { type LocalGhAuthStatus, probeLocalGhAuth, startLocalGhAuth } from './local-gh-auth';
import { getRemoteSwitchSetupService } from './remote-switch-setup';
import { switchSetupService } from './switch-setup-service';

export const switchSetupController = createRPCController({
  listOnboardable: () => switchSetupService.listOnboardable(),

  /** Whether this machine can fetch the MCP runtime from GitHub Packages. */
  getLocalGhAuth: (): Promise<LocalGhAuthStatus> => probeLocalGhAuth(),

  /** Interactive `gh` login/refresh on this machine; returns a PTY session id. */
  startLocalGhAuth: (): Promise<{ sessionId: string }> => startLocalGhAuth(),
  /**
   * Agent types installed on a remote host. An unreachable host has no
   * answerable list, so return none rather than throwing: this is a query that
   * paints UI, and its caller renders the host-unreachable state alongside it,
   * so the degraded result is disclosed. Throwing surfaced an ordinary,
   * expected condition as an unhandled handler error with a stack trace.
   */
  listOnboardableRemote: async (sshHost: string) => {
    if (hostReachabilityService.isBlocked(sshHost)) {
      log.warn('switchSetup.listOnboardableRemote: host unreachable — no agent types', { sshHost });
      return [];
    }
    const service = await getRemoteSwitchSetupService(sshHost);
    const statuses = await service.listAgentTypeStatuses();
    return statuses.filter((s) => s.installed).map((s) => ({ agentId: s.agentId }));
  },
  getStatus: (agentId: string) => switchSetupService.getStatus(agentId),
  checkForUpdates: (agentId: string) => switchSetupService.checkForUpdates(agentId),
  install: (agentId: string) => switchSetupService.install(agentId),
  update: (agentId: string) => switchSetupService.update(agentId),
  uninstall: (agentId: string) => switchSetupService.uninstall(agentId),
});
