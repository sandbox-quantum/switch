import type { ApprovalDecision, UserInputAnswers } from '@switch-console/agent-providers';
import { isProviderRuntime, type ProviderSessionRuntime } from '@main/core/agent-runtime/types';
import { sessionRuntimeManager } from '@main/core/sessions/session-runtime-manager';
import type {
  SessionTranscript,
  SessionTranscriptRpc,
} from '@shared/core/sessions/session-transcript';
import { createRPCController } from '@shared/lib/ipc/rpc';

/**
 * The runtime for a provider-backed session, or a thrown explanation.
 *
 * Every method here needs the same thing and none of them can do anything
 * useful without it, so the failure is one sentence naming the actual cause —
 * a session that is not provider-backed, or one that is not running — rather
 * than a null the renderer has to interpret.
 */
function requireProviderRuntime(sessionId: string): ProviderSessionRuntime {
  const agent = sessionRuntimeManager.getAgent(sessionId);
  if (agent === undefined) {
    throw new Error(`Session ${sessionId} is not running.`);
  }
  if (!isProviderRuntime(agent)) {
    throw new Error(
      `Session ${sessionId} runs in a terminal, not through a provider adapter — it has no transcript.`
    );
  }
  return agent;
}

/**
 * The renderer's half of a provider session: read the transcript, send a turn,
 * answer what the agent asked.
 *
 * A PTY session needs none of this — the renderer writes bytes at a terminal
 * over the `pty` controller and reads them back the same way. Everything here
 * exists because a provider session's conversation is structured, and the
 * structure is what the transcript view draws.
 */
export const sessionTranscriptController = createRPCController({
  async get(params: { sessionId: string }): Promise<SessionTranscript> {
    return requireProviderRuntime(params.sessionId).getTranscript();
  },
  async sendTurn(params: { sessionId: string; text: string }): Promise<{ turnId: string }> {
    return requireProviderRuntime(params.sessionId).sendTurn(params.text, 'console');
  },
  async interrupt(params: { sessionId: string }): Promise<void> {
    await requireProviderRuntime(params.sessionId).interrupt();
  },
  async respondToRequest(params: {
    sessionId: string;
    requestId: string;
    decision: ApprovalDecision;
  }): Promise<void> {
    // This RPC is the console's own card; the room answers through the relay.
    await requireProviderRuntime(params.sessionId).respondToRequest(
      params.requestId,
      params.decision,
      'console'
    );
  },
  async respondToUserInput(params: {
    sessionId: string;
    requestId: string;
    answers: UserInputAnswers;
  }): Promise<void> {
    await requireProviderRuntime(params.sessionId).respondToUserInput(
      params.requestId,
      params.answers
    );
  },
} satisfies SessionTranscriptRpc);
