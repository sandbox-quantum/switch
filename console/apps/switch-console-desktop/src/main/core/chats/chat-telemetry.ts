import { GatewayError } from '@main/core/switch-servers/gateway-client';
import { serverKindOf } from '@main/core/switch-servers/servers-store';
import type {
  TelemetryChatFailure,
  TelemetryChatMentions,
  TelemetryOutcome,
  TelemetryServerKind,
} from '@main/core/telemetry/events';
import type { ChatSendInput } from '@shared/core/chats/chats';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { ChatApiError } from './gateway';

/** What every chat event carries: the kind of server, and how the call went. */
export type ChatCallOutcome = {
  server_kind: TelemetryServerKind;
  outcome: TelemetryOutcome;
  failure_reason: TelemetryChatFailure;
};

/**
 * A failed chat call as an enumerated code. The gateway's refusal code and
 * message are never carried: a refusal is `refused`, and the server reports
 * its own side of it.
 */
export function chatFailureReason(error: unknown): TelemetryChatFailure {
  if (error instanceof ChatApiError) {
    if (error.status === 401) return 'unauthenticated';
    return error.status >= 500 ? 'server_error' : 'refused';
  }
  if (error instanceof GatewayError) {
    if (error.kind === 'unauthorized') return 'unauthenticated';
    if (error.kind === 'network') return 'network';
    return (error.status ?? 0) >= 500 ? 'server_error' : 'refused';
  }
  return 'error';
}

/** Whom a message names, read from what the composer sent. Never which. */
export function chatMentions(
  input: Pick<ChatSendInput, 'mentionAgentIds' | 'mentionUserIds' | 'mentionSpans'>
): TelemetryChatMentions {
  const spans = input.mentionSpans ?? [];
  const agent =
    (input.mentionAgentIds?.length ?? 0) > 0 || spans.some((span) => span.kind === 'agent');
  const person =
    (input.mentionUserIds?.length ?? 0) > 0 || spans.some((span) => span.kind === 'user');
  if (agent && person) return 'both';
  if (agent) return 'agent';
  return person ? 'person' : 'none';
}

/**
 * Run a chat call and report it either way. The failure still reaches the
 * caller; `emit` is told how it went, and reporting never changes the result.
 */
export async function reportingChatCall<T>(
  server: SwitchServer,
  run: () => Promise<T>,
  emit: (outcome: ChatCallOutcome) => void
): Promise<T> {
  const server_kind = serverKindOf(server);
  let result: T;
  try {
    result = await run();
  } catch (error) {
    emit({ server_kind, outcome: 'failure', failure_reason: chatFailureReason(error) });
    throw error;
  }
  emit({ server_kind, outcome: 'success', failure_reason: 'none' });
  return result;
}
