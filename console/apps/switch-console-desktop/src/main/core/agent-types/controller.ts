import { hostReachabilityService } from '@main/core/remote-hosts/production-host-reachability';
import { log } from '@main/lib/logger';
import type { AgentTypeAvailability } from '@shared/core/agent-types/agent-type-availability';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { listLocalAgentTypeAvailability, listRemoteAgentTypeAvailability } from './availability';

export const agentTypesController = createRPCController({
  /** Every agent type on this machine, usable or not. */
  listAvailability: () => listLocalAgentTypeAvailability(),

  /**
   * Every agent type on a remote host, usable or not.
   *
   * An unreachable host has no answerable list, so return none rather than
   * throwing: this is a query that paints UI, and its caller renders the
   * host-unreachable state alongside it, so the degraded result is disclosed.
   */
  listAvailabilityRemote: async (sshHost: string): Promise<AgentTypeAvailability[]> => {
    if (hostReachabilityService.isBlocked(sshHost)) {
      log.warn('agentTypes.listAvailabilityRemote: host unreachable — no agent types', {
        sshHost,
      });
      return [];
    }
    return listRemoteAgentTypeAvailability(sshHost);
  },
});
