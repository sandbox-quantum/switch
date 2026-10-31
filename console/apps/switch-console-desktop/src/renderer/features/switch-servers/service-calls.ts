import { rpc } from '@renderer/lib/ipc';
import type {
  ServiceFlow,
  ServiceKeyConnected,
} from '@shared/core/switch-servers/service-connection';

/**
 * What the connect steps ask Switch, bound to where they act: the server's own
 * workspace for the add-server onboarding, or the workspace a Connectors page
 * shows, so a page for one workspace never connects or disconnects in another.
 */
export type ServiceCalls = {
  startSignIn: (service: string, mcpEndpoint?: string) => Promise<string>;
  getSignIn: (service: string, flowId: string) => Promise<ServiceFlow>;
  cancelSignIn: (service: string, flowId: string) => Promise<void>;
  connectWithKey: (service: string, fields: Record<string, string>) => Promise<ServiceKeyConnected>;
  disconnect: (service: string) => Promise<{ warning: string | null }>;
};

export function serverServiceCalls(serverId: string): ServiceCalls {
  return {
    startSignIn: (service, mcpEndpoint) =>
      mcpEndpoint === undefined
        ? rpc.switchServers.startServiceConnection(serverId, service)
        : rpc.switchServers.startServiceConnection(serverId, service, mcpEndpoint),
    getSignIn: (service, flowId) => rpc.switchServers.getServiceFlow(serverId, service, flowId),
    cancelSignIn: (service, flowId) =>
      rpc.switchServers.cancelServiceConnection(serverId, service, flowId),
    connectWithKey: (service, fields) =>
      rpc.switchServers.connectServiceWithKey(serverId, service, fields),
    disconnect: (service) => rpc.switchServers.disconnectService(serverId, service),
  };
}

export function workspaceServiceCalls(workspaceId: string): ServiceCalls {
  return {
    startSignIn: (service, mcpEndpoint) =>
      rpc.workspaces.startServiceConnection({
        workspaceId,
        service,
        ...(mcpEndpoint === undefined ? {} : { mcpEndpoint }),
      }),
    getSignIn: (service, flowId) => rpc.workspaces.getServiceFlow({ workspaceId, service, flowId }),
    cancelSignIn: (service, flowId) =>
      rpc.workspaces.cancelServiceConnection({ workspaceId, service, flowId }),
    connectWithKey: (service, fields) =>
      rpc.workspaces.connectServiceWithKey({ workspaceId, service, fields }),
    disconnect: (service) => rpc.workspaces.disconnectService({ workspaceId, service }),
  };
}
