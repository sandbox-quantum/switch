import {
  AgentManagementUnavailableError,
  createManagedAgent,
  fetchManagedAgents,
  fetchManagementControllers,
  GatewayError,
  isGatewayTimeout,
  managementErrorCode,
  managementErrorMessage,
} from '@main/core/switch-servers/gateway-client';
import { agentTypeOf } from '@main/core/telemetry/agent-type';
import { entryPointOf } from '@main/core/telemetry/narrow';
import { trackEventAt } from '@main/core/telemetry/telemetry-service';
import { withReachableWorkspaceSession } from '@main/core/workspaces/workspace-session';
import { requireWorkspaceForServer } from '@main/core/workspaces/workspaces-store';
import { log } from '@main/lib/logger';
import { resolveMachine } from './agent-migration';
import { managedAgentLocator } from './managed-agent-location';
import { managedCreateFailureOf, NewManagedAgentService } from './new-managed-agent-service';

export const newManagedAgentService = new NewManagedAgentService({
  workspaceFor: async (serverId) => (await requireWorkspaceForServer(serverId)).id,
  machine: resolveMachine,
  managementAvailable: (workspaceId) =>
    withReachableWorkspaceSession(workspaceId, async (server) => {
      try {
        await fetchManagementControllers(server);
        return true;
      } catch (error) {
        if (error instanceof AgentManagementUnavailableError) return false;
        throw error;
      }
    }),
  create: (workspaceId, body) =>
    withReachableWorkspaceSession(workspaceId, async (server) => {
      try {
        return { kind: 'created', switchAgentId: await createManagedAgent(server, body) };
      } catch (error) {
        // Switch Console stopped waiting, but the server may have made the
        // agent: what exists is read back before anything is reported.
        if (isGatewayTimeout(error)) {
          const made = (await fetchManagedAgents(server)).find((a) => a.name === body.name);
          if (made) {
            log.warn('Creating a managed agent outlasted the wait; the server had made it', {
              event: 'new_managed_agent',
              agentId: made.agentId,
            });
            return { kind: 'created', switchAgentId: made.agentId };
          }
        }
        if (!(error instanceof GatewayError)) throw error;
        const failure = managedCreateFailureOf({
          kind: error.kind,
          status: error.status,
          code: managementErrorCode(error),
        });
        if (failure === null) throw error;
        if (failure === 'name-conflict') return { kind: 'name-conflict' };
        return { kind: 'refused', message: managementErrorMessage(error), reason: failure };
      }
    }),
  reportCreate: (input, failure_reason) => {
    const at = Date.now();
    void managedAgentLocator(input.serverId).then((locate) =>
      trackEventAt(
        'agent_created',
        {
          agent_type: agentTypeOf(input.providerId),
          location: locate(input.machineId),
          outcome: failure_reason === 'none' ? 'success' : 'failure',
          failure_reason,
          entry_point: entryPointOf(input.entryPoint),
        },
        at
      )
    );
  },
  thrownFailure: (error) =>
    error instanceof GatewayError && error.kind === 'unauthorized' ? 'unauthenticated' : 'error',
  log: {
    info: (message, fields) => log.info(message, { event: 'new_managed_agent', ...fields }),
    warn: (message, fields) => log.warn(message, { event: 'new_managed_agent', ...fields }),
    error: (message, fields) => log.error(message, { event: 'new_managed_agent', ...fields }),
  },
});
