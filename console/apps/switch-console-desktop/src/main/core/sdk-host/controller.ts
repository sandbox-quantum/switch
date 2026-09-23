import { serverEventSchema, snapshotSchema } from '@switch-console/shared/session-v1';
import type { AttachmentUpload, ClientCommand } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { getAgentById } from '@main/core/agents/getAgentById';
import { remoteSessionReconciler } from '@main/core/agents/remote-session-reconciler';
import { sessionRuntimeManager } from '@main/core/sessions/session-runtime-manager';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  uploadSdkAttachment,
  fetchSdkSnapshot,
  fetchSdkEvents,
  fetchSdkCommandStatus,
  submitSdkCommand,
  reconcileSdkCommand,
  retireSdkSession,
} from '../switch-servers/gateway-client';
import { getServer } from '../switch-servers/servers-store';
import { sharedAgentDiagnostics, sharedAgentLogs } from './diagnostics';
import { syncSdkSessionActivity } from './session-activity';
import { manageAgentSidecar } from './sidecar-management';
import { stopSharedSession } from './stop-shared-session';
async function sharedServer(serverId: string) {
  const server = await getServer(serverId);
  if (!server) throw new Error('Switch server not found.');
  return server;
}
export const sdkHostController = createRPCController({
  stop: async (serverId: string, sessionId: string) =>
    stopSharedSession(await sharedServer(serverId), sessionId),
  startupStatus: (sessionId: string) =>
    sessionRuntimeManager.getAgent(sessionId)?.startupStatus?.() ?? null,
  discoveryErrors: () => remoteSessionReconciler.errors(),
  retryDiscovery: (agentId: string) => remoteSessionReconciler.refresh(agentId),
  retire: async (serverId: string, sessionId: string, epoch: string) =>
    retireSdkSession(await sharedServer(serverId), sessionId, epoch),
  uploadAttachment: async (serverId: string, sessionId: string, file: AttachmentUpload) =>
    uploadSdkAttachment(await sharedServer(serverId), sessionId, file),
  agentDiagnostics: sharedAgentDiagnostics,
  agentLogs: sharedAgentLogs,
  manageSidecar: async (agentId: string, action: 'update' | 'restart' | 'stop' | 'start') =>
    manageAgentSidecar(agentId, z.enum(['update', 'restart', 'stop', 'start']).parse(action)),
  serverForAgent: async (agentId: string) => {
    const agent = await getAgentById(agentId);
    if (!agent?.serverId) throw new Error('This agent has no Switch server.');
    return agent.serverId;
  },
  sharedSnapshot: async (serverId: string, sessionId: string) => {
    const snapshot = snapshotSchema.parse(
      await fetchSdkSnapshot(await sharedServer(serverId), sessionId)
    );
    await syncSdkSessionActivity(snapshot.session);
    return snapshot;
  },
  sharedEvents: async (serverId: string, sessionId: string, after: number) => {
    const batch = z
      .array(serverEventSchema)
      .parse(await fetchSdkEvents(await sharedServer(serverId), sessionId, after));
    const latest = batch.filter((event) => event.body.type === 'session.upsert').at(-1);
    if (latest?.body.type === 'session.upsert') await syncSdkSessionActivity(latest.body.session);
    return batch;
  },
  sharedSubmit: async (serverId: string, command: ClientCommand) =>
    submitSdkCommand(await sharedServer(serverId), command),
  sharedReconcile: async (serverId: string, command: ClientCommand) =>
    reconcileSdkCommand(await sharedServer(serverId), command),
  sharedCommandStatus: async (serverId: string, sessionId: string, commandId: string) =>
    fetchSdkCommandStatus(await sharedServer(serverId), sessionId, commandId),
});
