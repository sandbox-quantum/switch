import { randomUUID } from 'node:crypto';
import type { ProviderAdapter, ProviderSendTurnInput } from '../../adapter';
import type { ProviderRuntimeEvent } from '../../events';
import { PROVIDER_DISPATCH, traceRecord } from './trace';

/**
 * The token the benchmark driver embeds in the body of every room message it
 * posts, so a host can name the message it was handed.
 *
 * A host never learns the id Switch minted for that message: what reaches the
 * adapter is the command text, and the only part of it the benchmark controls
 * is the body it wrote. Reading the id back out of Switch's own wording would
 * measure the wording — a template change between two revisions would empty
 * the sample set rather than move the number, which is the failure mode a
 * revision-to-revision comparison can least afford.
 */
const MARKER = /switch-bench:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

export function benchMarker(text: string): string | null {
  return MARKER.exec(text)?.[1] ?? null;
}

/**
 * A provider that does nothing but answer, timestamped.
 *
 * The benchmark measures Switch's connection model, so the provider has to be
 * out of the measurement: a real one would add seconds of model latency, its
 * own processes and its own memory to every figure, and none of that differs
 * between the two revisions being compared. What it must still do is behave
 * like a provider — reach `ready`, start a turn and finish it — because the
 * host will not dispatch a second room message to a session whose first turn
 * never completed.
 */
export function createBenchAdapter(): ProviderAdapter {
  const live = new Set<string>();
  const listeners = new Set<(event: ProviderRuntimeEvent) => void>();
  const emit = (sessionId: string, event: Record<string, unknown>) => {
    const full = {
      ...event,
      sessionId,
      provider: 'claude',
      eventId: randomUUID(),
      createdAt: new Date().toISOString(),
    } as ProviderRuntimeEvent;
    for (const listener of listeners) listener(full);
  };
  return {
    provider: 'claude',
    capabilities: {
      resume: true,
      steering: false,
      approvals: false,
      userInput: false,
      modelSwitchInSession: false,
    },
    startSession: async (input) => {
      live.add(input.sessionId);
      // One id, announced and returned. A real provider's session has a single
      // native identity, and resuming one is how a host recovers a session it
      // did not start. Minting a different id in the event and the return value
      // would leave the benchmark unable to exercise that path faithfully.
      const nativeSessionId = randomUUID();
      emit(input.sessionId, { type: 'session.started', nativeSessionId });
      emit(input.sessionId, { type: 'session.state.changed', status: 'ready' });
      return { provider: 'claude', sessionId: input.sessionId, nativeSessionId };
    },
    sendTurn: async (input: ProviderSendTurnInput) => {
      const marker = benchMarker(input.text);
      traceRecord(PROVIDER_DISPATCH, marker ?? `unmarked:${input.turnId}`, {
        sessionId: input.sessionId,
        turnId: input.turnId,
      });
      emit(input.sessionId, { type: 'turn.started', turnId: input.turnId });
      emit(input.sessionId, {
        type: 'turn.completed',
        turnId: input.turnId,
        outcome: 'completed',
      });
      return { turnId: input.turnId };
    },
    interruptTurn: async () => {},
    respondToRequest: async () => {},
    respondToUserInput: async () => {},
    stopSession: async (sessionId) => {
      live.delete(sessionId);
    },
    stopAll: async () => {
      live.clear();
    },
    hasSession: (sessionId) => live.has(sessionId),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
