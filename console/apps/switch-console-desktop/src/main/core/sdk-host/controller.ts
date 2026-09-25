import type { ClientCommand } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { getAgentById } from '@main/core/agents/getAgentById';
import { remoteSessionReconciler } from '@main/core/agents/remote-session-reconciler';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  listCloudAgents,
  runCloudSessionOperation,
  uploadCloudAttachment,
  wakeCloudAgent,
} from './cloud-control';
import { connectionHealth } from './connection-health';
import { sharedAgentDiagnostics, sharedAgentLogs } from './diagnostics';
import { sessionIssue, sessionStartupStatus } from './host-failures';
import { transcriptSource } from './host-journal';
import { placeSession } from './place-session';
import {
  reconcileSessionCommand,
  sessionCommandStatus,
  submitSessionCommand,
} from './session-commands';
import { manageAgentSidecar } from './sidecar-management';
import { stopSharedSession } from './stop-shared-session';
import { closeTranscript, openTranscript } from './transcripts';
export const sdkHostController = createRPCController({
  stop: (agentId: string, sessionId: string) => stopSharedSession(agentId, sessionId),
  startupStatus: (sessionId: string) => sessionStartupStatus(sessionId),
  sessionIssue: (sessionId: string) => sessionIssue(sessionId),
  discoveryErrors: () => remoteSessionReconciler.errors(),
  retryDiscovery: (agentId: string) => remoteSessionReconciler.refresh(agentId),
  connectionHealth,
  placeSession: (agentId: string, sessionId: string, roomId: string) =>
    placeSession(agentId, sessionId, roomId),
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
  cloudAgents: (serverId: string) => listCloudAgents(serverId),
  cloudWake: (agentId: string) => wakeCloudAgent(agentId),
  cloudSessionOperation: async (
    agentId: string,
    sessionId: string,
    operationId: string,
    action: 'start' | 'restart'
  ) =>
    runCloudSessionOperation(
      agentId,
      sessionId,
      z.string().uuid().parse(operationId),
      z.enum(['start', 'restart']).parse(action)
    ),
  cloudUploadAttachment: (
    agentId: string,
    sessionId: string,
    file: { name: string; mimeType: string; data: string }
  ) => uploadCloudAttachment(agentId, sessionId, file),
});
