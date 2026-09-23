import { providerAdapterRegistry } from '@main/core/agent-runtime/impl/provider-adapter-registry';
import { getRemoteDependencyManager } from '@main/core/dependencies/remote-dependency-manager';
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
    const manager = await getRemoteDependencyManager(sshHost);
    const acp = await Promise.all(
      ['cursor', 'antigravity'].map(async (agentId): Promise<AgentTypeAvailability> => {
        const cli = await manager.probe(agentId);
        return {
          agentId,
          available: cli.status === 'available',
          blockedReason:
            cli.status === 'available'
              ? null
              : cli.status === 'missing'
                ? `Install ${agentId === 'cursor' ? 'Cursor CLI' : 'Antigravity ACP'} on ${sshHost}.`
                : `Could not verify this CLI on ${sshHost}. Recheck the host setup.`,
          blockedKind:
            cli.status === 'available'
              ? null
              : cli.status === 'missing'
                ? 'not-installed'
                : 'unknown',
        };
      })
    );
    return [
      ...acp,
      ...statuses
        .filter((status) => !['cursor', 'antigravity'].includes(status.agentId))
        .map((status) => {
          if (!status.supported || !providerAdapterRegistry.supports(status.agentId)) {
            return {
              agentId: status.agentId,
              available: false,
              blockedReason: `Switch Console cannot manage this agent type on ${sshHost}.`,
              blockedKind: 'unsupported' as const,
            };
          }
          // A status that could not be read is not a status. `installed` is
          // false on such a row because it is false on every field of it, and
          // reporting that as "the connector is not installed" states as fact
          // the one thing the read failed to establish — then offers to install
          // something that may already be there. The local list says why; this
          // is the same answer for the same condition.
          if (status.refreshError !== null) {
            return {
              agentId: status.agentId,
              available: false,
              blockedReason: `Its Switch connector status could not be read on ${sshHost}: ${status.refreshError}`,
              blockedKind: 'unknown' as const,
            };
          }
          return status.installed
            ? {
                agentId: status.agentId,
                available: true,
                blockedReason: null,
                blockedKind: null,
              }
            : {
                agentId: status.agentId,
                available: false,
                blockedReason: `Its Switch connector is not installed on ${sshHost}.`,
                blockedKind: 'not-installed' as const,
              };
        }),
    ];
  },
  getStatus: (agentId: string) => switchSetupService.getStatus(agentId),
  checkForUpdates: (agentId: string) => switchSetupService.checkForUpdates(agentId),
  install: (agentId: string) => switchSetupService.install(agentId),
  update: (agentId: string) => switchSetupService.update(agentId, 'user'),
  uninstall: (agentId: string) => switchSetupService.uninstall(agentId),
});
