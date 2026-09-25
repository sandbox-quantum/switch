import type { ClientCommand } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { getAgentById } from '@main/core/agents/getAgentById';
import { remoteSessionReconciler } from '@main/core/agents/remote-session-reconciler';
import { sessionRuntimeManager } from '@main/core/sessions/session-runtime-manager';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { connectionHealth } from './connection-health';
import { sharedAgentDiagnostics, sharedAgentLogs } from './diagnostics';
import { hostFailure } from './host-failures';
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
/**
 * Where the session's startup is, as the open session view shows it: Console's
 * own start while it runs or once it failed, and otherwise a failure the
 * session's host recorded — which is also how a session the room watcher
 * started, and Console did not, shows that it could not start.
 */
function sessionStartupStatus(
  sessionId: string
): { status: 'starting' | 'ready' | 'error'; message: string | null } | null {
  const started = sessionRuntimeManager.getAgent(sessionId)?.startupStatus?.() ?? null;
  if (started && started.status !== 'ready') return started;
  const failure = hostFailure(sessionId);
  if (failure !== null) return { status: 'error', message: `Shared SDK host failed: ${failure}` };
  return started;
}

export const sdkHostController = createRPCController({
  stop: (agentId: string, sessionId: string) => stopSharedSession(agentId, sessionId),
  startupStatus: (sessionId: string) => sessionStartupStatus(sessionId),
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
});
