import type {
  ApprovalDecision,
  ApprovalOption,
  UserInputAnswers,
  UserInputQuestion,
} from '@switch-console/agent-providers';
import type { ProviderSessionRuntime } from '@main/core/agent-runtime/types';
import { log } from '@main/lib/logger';
import type { SwitchAgentCredentials } from './switch-credentials';
import type { MessagePayload } from './switch-event-format';
import { postRoomMessage } from './switch-room-client';

/**
 * A provider session's approvals and questions, asked and answered in its room.
 *
 * A PTY session has nowhere to put these: the dialog is inside a TUI nobody is
 * looking at, which is why `RoomConnection` gates injection on one rather than
 * trying to answer it. A provider session's requests are values on a wire, so
 * they can be posted where the person who asked the agent for something already
 * is — and answered from there, in a sentence.
 *
 * The rule is deliberately narrow: while a request is open, the **next**
 * addressed message for that session is read as its answer and is not delivered
 * as a turn. Anything else — deciding by mention shape, by timing, by who is
 * speaking — either guesses or requires a syntax nobody will remember.
 */

/** An open request, and everything needed to render and resolve it. */
type PendingRequest =
  | {
      kind: 'approval';
      requestId: string;
      title: string;
      detail?: string;
      options: ApprovalOption[];
    }
  | { kind: 'question'; requestId: string; questions: UserInputQuestion[] };

interface Binding {
  creds: SwitchAgentCredentials;
  /** The room the session currently holds, read at the moment it is needed. */
  room: () => string | null;
  runtime: ProviderSessionRuntime;
  pending: PendingRequest | null;
}

/** Words a person uses instead of picking a number. */
const AFFIRMATIVE = new Set(['yes', 'y', 'allow', 'approve', 'approved', 'ok', 'okay', 'sure']);
const NEGATIVE = new Set(['no', 'n', 'deny', 'denied', 'reject', 'rejected', 'decline', 'stop']);
const ALWAYS = new Set(['always', 'session', 'allow always', 'allow for this session']);

export type ParsedAnswer =
  | { kind: 'approval'; decision: ApprovalDecision; label: string }
  | { kind: 'answers'; answers: UserInputAnswers; summary: string }
  | { kind: 'unparsed' };

/**
 * Read a room reply as an answer to the open request.
 *
 * Accepts a number, an option's own label, or the plain English a person is
 * likely to type. A question that allows a custom answer takes anything at all,
 * which is why the numeric and label matches are tried first: "1" is an option
 * everywhere it could be one.
 */
export function parseRequestAnswer(text: string, pending: PendingRequest): ParsedAnswer {
  const trimmed = stripMentions(text).trim();
  if (!trimmed) return { kind: 'unparsed' };
  const lower = trimmed.toLowerCase();

  if (pending.kind === 'approval') {
    const index = optionIndex(trimmed, pending.options.length);
    if (index !== null) {
      const option = pending.options[index] as ApprovalOption;
      return { kind: 'approval', decision: option.decision, label: option.label };
    }
    const byLabel = pending.options.find((option) => option.label.toLowerCase() === lower);
    if (byLabel) return { kind: 'approval', decision: byLabel.decision, label: byLabel.label };
    if (ALWAYS.has(lower)) {
      return { kind: 'approval', decision: 'acceptForSession', label: 'Allowed for this session' };
    }
    if (AFFIRMATIVE.has(lower)) return { kind: 'approval', decision: 'accept', label: 'Approved' };
    if (NEGATIVE.has(lower)) return { kind: 'approval', decision: 'decline', label: 'Denied' };
    return { kind: 'unparsed' };
  }

  // One question is the overwhelmingly common case and the only one a single
  // room message can answer unambiguously; a multi-question ask is answered
  // question-by-question, which the room cannot express, so the reply answers
  // the first and the rest are left to the console.
  const question = pending.questions[0];
  if (!question) return { kind: 'unparsed' };

  const index = optionIndex(trimmed, question.options.length);
  if (index !== null) {
    const option = question.options[index] as { label: string; value: string };
    return {
      kind: 'answers',
      answers: { [question.id]: option.value },
      summary: option.label,
    };
  }
  const byLabel = question.options.find((option) => option.label.toLowerCase() === lower);
  if (byLabel) {
    return { kind: 'answers', answers: { [question.id]: byLabel.value }, summary: byLabel.label };
  }
  if (question.allowCustomAnswer) {
    return { kind: 'answers', answers: { [question.id]: trimmed }, summary: trimmed };
  }
  return { kind: 'unparsed' };
}

/** A bare 1-based option number, or null when the text is not one. */
function optionIndex(text: string, count: number): number | null {
  const match = /^(\d+)[.)]?$/.exec(text);
  if (!match?.[1]) return null;
  const index = Number(match[1]) - 1;
  return index >= 0 && index < count ? index : null;
}

/**
 * Strip the leading mention that addressed the agent, so "@bot 2" reads as "2".
 *
 * Only at the start, and only one: a mention in the middle of a sentence is
 * part of the answer.
 */
function stripMentions(text: string): string {
  return text.replace(/^\s*@[\w.-]+[:,]?\s*/, '');
}

/** The message the room is shown when the agent needs a decision. */
export function renderRequest(pending: PendingRequest): string {
  if (pending.kind === 'approval') {
    const options = pending.options
      .map((option, index) => `${index + 1}. ${option.label}`)
      .join('  ');
    const detail = pending.detail ? `\n\`${pending.detail}\`` : '';
    return (
      `**I need permission to continue.**\n${pending.title}${detail}\n\n${options}\n\n` +
      'Reply to me with the number, or say allow / deny.'
    );
  }

  const blocks = pending.questions.map((question) => {
    const header = question.header ? `**${question.header}**\n` : '';
    const options = question.options
      .map((option, index) => `${index + 1}. ${option.label}`)
      .join('\n');
    const custom = question.allowCustomAnswer ? '\nor type your own answer' : '';
    return `${header}${question.question}\n${options}${custom}`;
  });
  return `**I have a question.**\n\n${blocks.join('\n\n')}\n\nReply to me to answer.`;
}

const UNPARSED_HINT =
  "I couldn't read that as an answer to what I asked. Reply with the number of an option (or allow / deny).";

class ProviderRoomRelay {
  private readonly bindings = new Map<string, Binding>();

  /**
   * Follow a provider session's room. Called by the poller once it has both the
   * session's credentials and its connection, so the relay never has to resolve
   * either itself.
   */
  bind(params: {
    sessionId: string;
    creds: SwitchAgentCredentials;
    room: () => string | null;
    runtime: ProviderSessionRuntime;
  }): void {
    this.bindings.set(params.sessionId, {
      creds: params.creds,
      room: params.room,
      runtime: params.runtime,
      pending: null,
    });
  }

  unbind(sessionId: string): void {
    this.bindings.delete(sessionId);
  }

  /** Whether this session's requests are being relayed to a room at all. */
  isBound(sessionId: string): boolean {
    return this.bindings.has(sessionId);
  }

  /** A request the agent opened: post it into the room and start waiting. */
  onRequestOpened(
    sessionId: string,
    event:
      | {
          type: 'request.opened';
          requestId: string;
          title: string;
          detail?: string;
          options: ApprovalOption[];
        }
      | { type: 'user-input.requested'; requestId: string; questions: UserInputQuestion[] }
  ): void {
    const binding = this.bindings.get(sessionId);
    if (!binding) return;
    const room = binding.room();
    if (room === null) {
      // Nothing is lost: the request is in the transcript and answerable from
      // the console. Say so rather than silently posting nowhere.
      log.warn('ProviderRoomRelay: a request opened before the session had a room', {
        event: 'provider_request_without_room',
        sessionId,
        requestId: event.requestId,
      });
      return;
    }

    const pending: PendingRequest =
      event.type === 'request.opened'
        ? {
            kind: 'approval',
            requestId: event.requestId,
            title: event.title,
            ...(event.detail !== undefined ? { detail: event.detail } : {}),
            options: event.options,
          }
        : { kind: 'question', requestId: event.requestId, questions: event.questions };
    // The newest request is the one a reply answers. An older one still open is
    // not forgotten — it stays answerable from the console — but the room can
    // only be waiting on one thing at a time.
    binding.pending = pending;

    void this.post(binding, room, renderRequest(pending)).catch((error: unknown) => {
      log.warn('ProviderRoomRelay: could not post a request into the room', {
        sessionId,
        roomId: room,
        error: String(error),
      });
    });
  }

  /** The request went away — answered here, in the console, or on a stop. */
  onRequestResolved(sessionId: string, requestId: string): void {
    const binding = this.bindings.get(sessionId);
    if (binding?.pending?.requestId !== requestId) return;
    binding.pending = null;
  }

  /**
   * Read an addressed room message as an answer, if one is owed.
   *
   * Returns true when the message was consumed, which is what stops it being
   * delivered to the agent as a turn: a "2" arriving as a prompt is at best
   * noise and at worst an instruction.
   */
  consume(sessionId: string, message: MessagePayload | null): boolean {
    const binding = this.bindings.get(sessionId);
    const pending = binding?.pending;
    if (!binding || !pending || !message) return false;
    const room = binding.room();
    if (room === null) return false;

    const parsed = parseRequestAnswer(message.body ?? '', pending);
    if (parsed.kind === 'unparsed') {
      void this.post(binding, room, UNPARSED_HINT).catch(() => {});
      // Consumed anyway: it was a reply to the question, not a new instruction,
      // and handing it to the agent as a turn while the agent is blocked on the
      // very request it answers is how a session deadlocks on its own prompt.
      return true;
    }

    binding.pending = null;
    void this.answer(binding, room, pending, parsed).catch((error: unknown) => {
      log.warn('ProviderRoomRelay: failed to answer a request from the room', {
        sessionId,
        requestId: pending.requestId,
        error: String(error),
      });
    });
    return true;
  }

  private async answer(
    binding: Binding,
    room: string,
    pending: PendingRequest,
    parsed: Exclude<ParsedAnswer, { kind: 'unparsed' }>
  ): Promise<void> {
    if (parsed.kind === 'approval') {
      await binding.runtime.respondToRequest(pending.requestId, parsed.decision);
      await this.post(binding, room, `✅ ${parsed.label}`);
      return;
    }
    await binding.runtime.respondToUserInput(pending.requestId, parsed.answers);
    await this.post(binding, room, `✅ Answered: ${parsed.summary}`);
  }

  private async post(binding: Binding, room: string, content: string): Promise<void> {
    await postRoomMessage(binding.creds, room, content);
  }
}

export const providerRoomRelay = new ProviderRoomRelay();
