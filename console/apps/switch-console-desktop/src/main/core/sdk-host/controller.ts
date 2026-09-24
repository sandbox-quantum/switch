import { snapshotSchema } from '@switch-console/shared/session-v1';
import type { ClientCommand } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { getAgentById } from '@main/core/agents/getAgentById';
import { remoteSessionReconciler } from '@main/core/agents/remote-session-reconciler';
import { sessionRuntimeManager } from '@main/core/sessions/session-runtime-manager';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { reconnectSdkRoom } from '../switch-servers/gateway-client';
import { getServer } from '../switch-servers/servers-store';
import { connectionHealth } from './connection-health';
import { sharedAgentDiagnostics, sharedAgentLogs } from './diagnostics';
import { hostJournals, transcriptSource } from './host-journal';
import { syncSdkSessionActivity } from './session-activity';
import {
  reconcileSessionCommand,
  sessionCommandStatus,
  submitSessionCommand,
} from './session-commands';
import { manageAgentSidecar } from './sidecar-management';
import { stopSharedSession } from './stop-shared-session';
async function sharedServer(serverId: string) {
  const server = await getServer(serverId);
  if (!server) throw new Error('Switch server not found.');
  return server;
}
export const sdkHostController = createRPCController({
  stop: (agentId: string, sessionId: string) => stopSharedSession(agentId, sessionId),
  startupStatus: (sessionId: string) =>
    sessionRuntimeManager.getAgent(sessionId)?.startupStatus?.() ?? null,
  discoveryErrors: () => remoteSessionReconciler.errors(),
  retryDiscovery: (agentId: string) => remoteSessionReconciler.refresh(agentId),
  connectionHealth,
  reconnectRoom: async (
    serverId: string,
    sessionId: string,
    epoch: string,
    roomId: string,
    expectedOwner: string | null
  ) =>
    snapshotSchema.parse(
      await reconnectSdkRoom(await sharedServer(serverId), sessionId, {
        epoch,
        room_id: roomId,
        expected_owner: expectedOwner,
      })
    ),
  agentDiagnostics: sharedAgentDiagnostics,
  agentLogs: sharedAgentLogs,
  manageSidecar: async (agentId: string, action: 'update' | 'restart' | 'stop' | 'start') =>
    manageAgentSidecar(agentId, z.enum(['update', 'restart', 'stop', 'start']).parse(action)),
  serverForAgent: async (agentId: string) => {
    const agent = await getAgentById(agentId);
    if (!agent?.serverId) throw new Error('This agent has no Switch server.');
    return agent.serverId;
  },
  transcriptSource,
  journalSnapshot: async (agentId: string, sessionId: string) => {
    const snapshot = (await hostJournals.tail(agentId, sessionId)).snapshot();
    await syncSdkSessionActivity(snapshot.session);
    return snapshot;
  },
  journalEvents: async (agentId: string, sessionId: string, after: number) => {
    const batch = (await hostJournals.tail(agentId, sessionId)).after(after);
    const latest = batch.filter((event) => event.body.type === 'session.upsert').at(-1);
    if (latest?.body.type === 'session.upsert') await syncSdkSessionActivity(latest.body.session);
    return batch;
  },
  sessionSubmit: (agentId: string, command: ClientCommand) =>
    submitSessionCommand(agentId, command),
  sessionReconcile: (agentId: string, command: ClientCommand) =>
    reconcileSessionCommand(agentId, command),
  sessionCommandStatus: (agentId: string, sessionId: string, commandId: string) =>
    sessionCommandStatus(agentId, sessionId, commandId),
});
