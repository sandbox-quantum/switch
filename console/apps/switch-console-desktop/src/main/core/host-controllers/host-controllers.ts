import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { app } from 'electron';
import { listManagedAgentRecords } from '@main/core/agent-migration/managed-agents-store';
import { resolveAgentControllerBundlePath } from '@main/core/agent-runtime/impl/resolve-sidecar-bundle';
import { getAgentById } from '@main/core/agents/getAgentById';
import { placedOn } from '@main/core/embedded-controller/management-port';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { ensureHostBundle } from '@main/core/sdk-host/host-bundle';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import {
  AgentManagementUnavailableError,
  fetchManagedAgents,
  fetchManagementControllers,
  issueEnrollmentCode,
  managementErrorCode,
  managementErrorMessage,
  revokeManagementController,
} from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { withReachableWorkspaceSession } from '@main/core/workspaces/workspace-session';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { hostControllerStateChannel } from '@shared/events/hostControllerEvents';
import { HostControllerFile } from './host-controller-records';
import { type HostShell, HostControllerService } from './host-controller-service';

async function shellFor(sshHost: string): Promise<HostShell> {
  const connectionId = sshConnectionIdForHost(sshHost);
  const proxy = await ensureSshConnected(connectionId, sshHost);
  const ctx = new SshExecutionContext(proxy);
  return {
    script: async (script, args) => (await ctx.exec('node', ['-e', script, ...args])).stdout,
    upload: async (localPath, remotePath) => {
      const fs = new SshFileSystem(proxy, dirname(remotePath));
      try {
        await fs.copyLocalFile(localPath, basename(remotePath));
      } finally {
        fs.close();
      }
    },
    close: () => ctx.dispose(),
  };
}

let controllerBundle: { path: string; hash: string } | null = null;

export const hostControllerService = new HostControllerService({
  shell: shellFor,
  records: new HostControllerFile(() =>
    join(app.getPath('userData'), 'host-controllers', 'state.json')
  ),
  management: {
    enrollmentCode: async (workspaceId) => {
      try {
        return await withReachableWorkspaceSession(workspaceId, issueEnrollmentCode);
      } catch (error) {
        if (error instanceof AgentManagementUnavailableError) throw error;
        throw new Error(
          `Switch did not issue an enrollment code: ${managementErrorMessage(error)}`,
          {
            cause: error,
          }
        );
      }
    },
    serverApiUrl: async (serverId) => (await getServer(serverId))?.url ?? null,
    read: async (workspaceId, controllerId) => {
      try {
        return await withReachableWorkspaceSession(workspaceId, async (server) => {
          const controllers = await fetchManagementControllers(server);
          if (controllerId === null) return { kind: 'ok', controller: null, agents: [] };
          return placedOn(controllerId, controllers, await fetchManagedAgents(server));
        });
      } catch (error) {
        if (error instanceof AgentManagementUnavailableError) return { kind: 'unavailable' };
        return { kind: 'error', message: managementErrorMessage(error) };
      }
    },
    revoke: async (workspaceId, controllerId) => {
      try {
        await withReachableWorkspaceSession(workspaceId, (server) =>
          revokeManagementController(server, controllerId)
        );
        return 'revoked';
      } catch (error) {
        if (managementErrorCode(error) === 'not_found') return 'already_gone';
        throw new Error(
          `Could not remove the host’s controller from Switch, so it keeps running: ${managementErrorMessage(error)}`,
          { cause: error }
        );
      }
    },
  },
  bundles: {
    controller: async () => {
      const path = resolveAgentControllerBundlePath();
      if (controllerBundle?.path !== path)
        controllerBundle = {
          path,
          hash: createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        };
      return controllerBundle;
    },
    sharedHost: async (sshHost) =>
      (
        await ensureHostBundle({
          kind: 'ssh',
          host: sshHost,
          dir: '',
          connectionId: sshConnectionIdForHost(sshHost),
        })
      ).entrypoint,
  },
  movedAgents: async (sshHost, serverId) => {
    const names: string[] = [];
    for (const record of await listManagedAgentRecords()) {
      if (record.placement.kind !== 'ssh-host' || record.placement.sshHost !== sshHost) continue;
      const agent = await getAgentById(record.agentId);
      if (agent && agent.serverId !== serverId) continue;
      names.push(agent?.name ?? record.agentId);
    }
    return names;
  },
  emit: (event) => events.emit(hostControllerStateChannel, event),
  log: {
    info: (message, fields) => log.info(message, { event: 'host_controller', ...fields }),
    warn: (message, fields) => log.warn(message, { event: 'host_controller', ...fields }),
    error: (message, fields) => log.error(message, { event: 'host_controller', ...fields }),
  },
  now: Date.now,
});
