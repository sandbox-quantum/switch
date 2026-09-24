import type { ClientCommand } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { getAgentById } from '@main/core/agents/getAgentById';
import { remoteSessionReconciler } from '@main/core/agents/remote-session-reconciler';
import { sessionRuntimeManager } from '@main/core/sessions/session-runtime-manager';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { placeSession } from '../switch-servers/gateway-client';
import { getServer } from '../switch-servers/servers-store';
import { connectionHealth } from './connection-health';
import { sharedAgentDiagnostics, sharedAgentLogs } from './diagnostics';
import { transcriptSource } from './host-journal';
import {
  reconcileSessionCommand,
  sessionCommandStatus,
  submitSessionCommand,
} from './session-commands';
import { manageAgentSidecar } from './sidecar-management';
import { stopSharedSession } from './stop-shared-session';
import { closeTranscript, openTranscript } from './transcripts';
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
  placeSession: async (agentId: string, sessionId: string, roomId: string) => {
    const agent = await getAgentById(agentId);
    if (!agent?.serverId || !agent.switchAgentId)
      throw new Error('This agent is not linked to Switch.');
    return placeSession(await sharedServer(agent.serverId), agent.switchAgentId, sessionId, roomId);
  },
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
  transcriptOpen: (agentId: string, sessionId: string) => openTranscript(agentId, sessionId),
  transcriptClose: (sessionId: string) => closeTranscript(sessionId),
  sessionSubmit: (agentId: string, command: ClientCommand) =>
    submitSessionCommand(agentId, command),
  sessionReconcile: (agentId: string, command: ClientCommand) =>
    reconcileSessionCommand(agentId, command),
  sessionCommandStatus: (agentId: string, sessionId: string, commandId: string) =>
    sessionCommandStatus(agentId, sessionId, commandId),
});
