import type { UserInputAnswers, UserInputQuestion } from '@switch-console/agent-providers';
import type { TranscriptSessionState } from '@shared/core/sessions/session-transcript';

/** One question's collected answer: chosen option values plus any typed text. */
export interface QuestionDraft {
  selected: string[];
  custom: string;
}

export const emptyDraft = (): QuestionDraft => ({ selected: [], custom: '' });

/**
 * The answer for one question, as the provider expects it: an array for a
 * multi-select, a single value otherwise, and `null` while it is unanswered.
 *
 * Typed text wins over a selection when both are present — a person who typed
 * something meant it — except in a multi-select, where it joins the list.
 */
export function draftToAnswer(
  question: UserInputQuestion,
  draft: QuestionDraft
): string | string[] | null {
  const custom = draft.custom.trim();
  if (question.multiSelect) {
    const values = custom ? [...draft.selected, custom] : draft.selected;
    return values.length > 0 ? values : null;
  }
  if (custom) return custom;
  return draft.selected[0] ?? null;
}

/**
 * Every question answered, or `null` while any is not — the provider is waiting
 * on all of them, so a partial submission would leave it blocked with no sign
 * of why.
 */
export function draftsToAnswers(
  questions: UserInputQuestion[],
  drafts: Record<string, QuestionDraft>
): UserInputAnswers | null {
  const answers: UserInputAnswers = {};
  for (const question of questions) {
    const answer = draftToAnswer(question, drafts[question.id] ?? emptyDraft());
    if (answer === null) return null;
    answers[question.id] = answer;
  }
  return answers;
}

/**
 * What the composer says it will do with what is typed.
 *
 * A message sent while a turn is running is not queued behind it — it is
 * delivered into the turn — and the box has to say so, or a person waits for a
 * reply that already arrived somewhere else.
 */
export function composerPlaceholder(state: TranscriptSessionState, running: boolean): string {
  if (state === 'starting') return 'Starting the session…';
  if (state === 'stopped') return 'The session has stopped.';
  if (state === 'error') return 'The session is in an error state.';
  if (running) return 'Send into the running turn…';
  return 'Message the agent…';
}
