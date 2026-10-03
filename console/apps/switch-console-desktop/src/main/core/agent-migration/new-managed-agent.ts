import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { checkNewAgent, writeNewAgentConfigFile } from '@main/core/agents/add-agent';
import { agentEvents } from '@main/core/agents/agent-events';
import { resolveWorkdirFsFor } from '@main/core/agents/agent-workdir-fs';
import { createAgent } from '@main/core/agents/createAgent';
import { locationManager } from '@main/core/locations/location-manager';
import { ensureLocation, getLocationById } from '@main/core/locations/store';
import {
  AgentManagementUnavailableError,
  createManagedAgent,
  deleteAgent,
  deleteManagedAgent,
  fetchManagementControllers,
  GatewayError,
  managementErrorMessage,
  setManagedAgentDesiredState,
  updateAgentIcon,
} from '@main/core/switch-servers/gateway-client';
import { withReachableWorkspaceSession } from '@main/core/workspaces/workspace-session';
import { db } from '@main/db/client';
import { agents as agentsTable } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { agentAvatarUrlForName } from '@shared/core/agents/agent-avatar';
import { basenameFromAnyPath } from '@shared/path-name';
import { resolveMachine } from './agent-migration';
import { deleteManagedAgentRecord, setManagedAgentRecord } from './managed-agents-store';
import { NewManagedAgentService } from './new-managed-agent-service';

export const newManagedAgentService = new NewManagedAgentService({
  check: checkNewAgent,
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
  management: {
    create: (workspaceId, body) =>
      withReachableWorkspaceSession(workspaceId, async (server) => {
        try {
          return { kind: 'created', switchAgentId: await createManagedAgent(server, body) };
        } catch (error) {
          if (error instanceof GatewayError && error.status === 409)
            return { kind: 'name-conflict' };
          if (error instanceof GatewayError && error.status !== undefined && error.status < 500)
            return { kind: 'refused', message: managementErrorMessage(error) };
          throw error;
        }
      }),
    setIcon: (workspaceId, switchAgentId, iconUrl) =>
      withReachableWorkspaceSession(workspaceId, async (server) => {
        await updateAgentIcon(server, switchAgentId, iconUrl);
      }),
    setDesiredState: (workspaceId, switchAgentId, desiredState) =>
      withReachableWorkspaceSession(workspaceId, (server) =>
        setManagedAgentDesiredState(server, switchAgentId, desiredState)
      ),
    release: (workspaceId, switchAgentId) =>
      withReachableWorkspaceSession(workspaceId, async (server) => {
        await deleteManagedAgent(server, switchAgentId);
      }),
    deleteAgent: (workspaceId, switchAgentId) =>
      withReachableWorkspaceSession(workspaceId, (server) => deleteAgent(server, switchAgentId)),
  },
  defaultIcon: agentAvatarUrlForName,
  writeConfig: async (params) => {
    const workdir = await resolveWorkdirFsFor(params.sshHost, params.dir);
    try {
      await writeNewAgentConfigFile(workdir.fs, params);
    } finally {
      workdir.close();
    }
  },
  store: { set: setManagedAgentRecord, delete: deleteManagedAgentRecord },
  rows: {
    create: async ({ id, params, switchAgentId, server, workspace }) => {
      const location = await ensureLocation({
        sshHost: params.sshHost,
        dir: params.dir,
        name: basenameFromAnyPath(params.dir) ?? params.name,
      });
      return createAgent({
        id,
        locationId: location.id,
        name: params.name,
        providerId: params.providerId,
        switchAgentId,
        apiEndpoint: server.apiUrl,
        workspaceId: workspace.id,
        autoApprove: params.autoApprove,
        providerConfig: null,
      });
    },
    discard: async (agentId) => {
      await db.delete(agentsTable).where(eq(agentsTable.id, agentId));
    },
  },
  announce: async (agent, entryPoint) => {
    const location = await getLocationById(agent.locationId);
    if (!location) throw new Error(`The new agent's location ${agent.locationId} is gone.`);
    await locationManager.openLocation(location);
    agentEvents._emit('agent:created', agent, entryPoint);
  },
  newId: randomUUID,
  now: Date.now,
  log: {
    info: (message, fields) => log.info(message, { event: 'new_managed_agent', ...fields }),
    warn: (message, fields) => log.warn(message, { event: 'new_managed_agent', ...fields }),
    error: (message, fields) => log.error(message, { event: 'new_managed_agent', ...fields }),
  },
});
