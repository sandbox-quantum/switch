import type { AttachmentUpload, ClientCommand } from '@switch-console/shared/session-v1';
import { getAgentById } from '@main/core/agents/getAgentById';
import { remoteSessionReconciler } from '@main/core/agents/remote-session-reconciler';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  fetchSdkSessions,
  uploadSdkAttachment,
  fetchSdkSnapshot,
  fetchSdkEvents,
  fetchSdkCommandStatus,
  submitSdkCommand,
  retireSdkSession,
} from '../switch-servers/gateway-client';
import { getServer } from '../switch-servers/servers-store';
import { sharedAgentDiagnostics } from './diagnostics';
async function sharedServer(serverId: string) {
  const server = await getServer(serverId);
  if (!server) throw new Error('Switch server not found.');
  return server;
}
export const sdkHostController = createRPCController({
  discoveryErrors: () => remoteSessionReconciler.errors(),
  retryDiscovery: (agentId: string) => remoteSessionReconciler.refresh(agentId),
  retire: async (serverId: string, sessionId: string, epoch: string) =>
    retireSdkSession(await sharedServer(serverId), sessionId, epoch),
  uploadAttachment: async (serverId: string, sessionId: string, file: AttachmentUpload) =>
    uploadSdkAttachment(await sharedServer(serverId), sessionId, file),
  agentDiagnostics: sharedAgentDiagnostics,
  serverForAgent: async (agentId: string) => {
    const agent = await getAgentById(agentId);
    if (!agent?.serverId) throw new Error('This agent has no Switch server.');
    return agent.serverId;
  },
  sharedList: async (serverId: string) => fetchSdkSessions(await sharedServer(serverId)),
  sharedSnapshot: async (serverId: string, sessionId: string) =>
    fetchSdkSnapshot(await sharedServer(serverId), sessionId),
  sharedEvents: async (serverId: string, sessionId: string, after: number) =>
    fetchSdkEvents(await sharedServer(serverId), sessionId, after),
  sharedSubmit: async (serverId: string, command: ClientCommand) =>
    submitSdkCommand(await sharedServer(serverId), command),
  sharedCommandStatus: async (serverId: string, sessionId: string, commandId: string) =>
    fetchSdkCommandStatus(await sharedServer(serverId), sessionId, commandId),
});
