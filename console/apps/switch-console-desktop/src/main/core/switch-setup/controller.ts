import { hostReachabilityService } from '@main/core/remote-hosts/production-host-reachability';
import { log } from '@main/lib/logger';
import type { AgentTypeAvailability } from '@shared/core/switch-setup/agent-type-availability';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { getRemoteSwitchSetupService } from './remote-switch-setup';
import { switchSetupService } from './switch-setup-service';

export const switchSetupController = createRPCController({
  /** Every Switch-capable agent type on this machine, usable or not. */
  listAgentTypeAvailability: () => switchSetupService.listAgentTypeAvailability(),

  /**
   * Every Switch-capable agent type on a remote host, usable or not.
   *
   * An unreachable host has no answerable list, so return none rather than
   * throwing: this is a query that paints UI, and its caller renders the
   * host-unreachable state alongside it, so the degraded result is disclosed.
   * Throwing surfaced an ordinary, expected condition as an unhandled handler
   * error with a stack trace.
   */
  listAgentTypeAvailabilityRemote: async (sshHost: string): Promise<AgentTypeAvailability[]> => {
    if (hostReachabilityService.isBlocked(sshHost)) {
      log.warn('switchSetup.listAgentTypeAvailabilityRemote: host unreachable — no agent types', {
        sshHost,
      });
      return [];
    }
    const service = await getRemoteSwitchSetupService(sshHost);
    const statuses = await service.listAgentTypeStatuses();
    return statuses.map((status) => {
      if (!status.supported) {
        return {
          agentId: status.agentId,
          available: false,
          blockedReason: `Switch Console cannot manage this agent type on ${sshHost}.`,
        };
      }
      return status.installed
        ? { agentId: status.agentId, available: true, blockedReason: null }
        : {
            agentId: status.agentId,
            available: false,
            blockedReason: `Its Switch connector is not installed on ${sshHost}.`,
          };
    });
  },
  getStatus: (agentId: string) => switchSetupService.getStatus(agentId),
  checkForUpdates: (agentId: string) => switchSetupService.checkForUpdates(agentId),
  install: (agentId: string) => switchSetupService.install(agentId),
  update: (agentId: string) => switchSetupService.update(agentId),
  uninstall: (agentId: string) => switchSetupService.uninstall(agentId),
});
