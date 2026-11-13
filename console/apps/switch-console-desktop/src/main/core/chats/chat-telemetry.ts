import { GatewayError } from '@main/core/switch-servers/gateway-client';
import { serverKindOf } from '@main/core/switch-servers/servers-store';
import type {
  TelemetryChatFailure,
  TelemetryChatMentions,
  TelemetryOutcome,
  TelemetryServerKind,
} from '@main/core/telemetry/events';
import { log } from '@main/lib/logger';
import type { ChatSendInput } from '@shared/core/chats/chats';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { ChatApiError } from './gateway';

/** What every chat event carries: the kind of server, and how the call went. */
export type ChatCallOutcome = {
  server_kind: TelemetryServerKind;
  outcome: TelemetryOutcome;
  failure_reason: TelemetryChatFailure;
};

/** Reports a settled chat call; `result` is null when it failed. */
export type ChatCallEmit<T> = (outcome: ChatCallOutcome, result: T | null) => void;

function failureForStatus(status: number): TelemetryChatFailure {
  if (status === 401) return 'unauthenticated';
  if (status === 408) return 'network';
  if (status === 429) return 'rate_limited';
  return status >= 500 ? 'server_error' : 'refused';
}

/**
 * A failed chat call as an enumerated code. The gateway's refusal code and
 * message are never carried: a refusal is `refused`, and the server reports
 * its own side of it.
 */
export function chatFailureReason(error: unknown): TelemetryChatFailure {
  if (error instanceof ChatApiError) {
    return error.apiCode === 'REQUEST_REUSED' ? 'request_reused' : failureForStatus(error.status);
  }
  if (error instanceof GatewayError) {
    if (error.kind === 'unauthorized') return 'unauthenticated';
    if (error.kind === 'network') return 'network';
    return failureForStatus(error.status ?? 0);
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
 * Requests already reported as done, by server and request id, so a retry the
 * server answers from its first attempt is not counted twice. Bounded: the
 * oldest is forgotten first.
 */
const REPORTED_LIMIT = 500;
const reported = new Set<string>();

function alreadyReported(server: SwitchServer, requestId: string | null): boolean {
  return requestId !== null && reported.has(`${server.id}:${requestId}`);
}

function markReported(server: SwitchServer, requestId: string | null): void {
  if (requestId === null) return;
  reported.add(`${server.id}:${requestId}`);
  if (reported.size > REPORTED_LIMIT) reported.delete(reported.values().next().value!);
}

function emitSafely<T>(
  server: SwitchServer,
  emit: ChatCallEmit<T>,
  outcome: Omit<ChatCallOutcome, 'server_kind'>,
  result: T | null
): void {
  try {
    emit({ server_kind: serverKindOf(server), ...outcome }, result);
  } catch (error) {
    log.warn('telemetry: chat event not reported', {
      event: 'telemetry_chat_report_failed',
      error: String(error),
    });
  }
}

/**
 * Run a chat call and report it either way. The call's own result or error
 * reaches the caller unchanged: a report that throws is logged and dropped.
 * `requestId`, for a call the server makes idempotent, keeps a retry of a
 * call already reported as done from being counted again.
 */
export async function reportingChatCall<T>(
  server: SwitchServer,
  requestId: string | null,
  run: () => Promise<T>,
  emit: ChatCallEmit<T>
): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (error) {
    emitSafely(
      server,
      emit,
      { outcome: 'failure', failure_reason: chatFailureReason(error) },
      null
    );
    throw error;
  }
  if (!alreadyReported(server, requestId)) {
    markReported(server, requestId);
    emitSafely(server, emit, { outcome: 'success', failure_reason: 'none' }, result);
  }
  return result;
}
