import { useEffect, useRef, useState } from 'react';
import type { ChatApproval, ChatApprovalAnswer } from '../contracts/activity';
import { failureText } from '../model/failures';
import { Button } from '../primitives/button';
import { Textarea } from '../primitives/textarea';

type Answers = NonNullable<ChatApproval['answers']>;

function settledLabel(request: ChatApproval): string {
  if (request.state === 'expired') return 'Expired';
  if (request.state !== 'answered') return 'Request closed';
  const decision = request.options.find((option) => option.id === request.answer)?.decision;
  if (decision === 'decline') return 'Denied';
  if (decision === 'cancel') return 'Closed';
  return decision ? 'Approved' : 'Answered';
}

/**
 * An agent's request as the chat shows it, from Switch's copy: answered
 * through Switch as the signed-in person, so it needs no connection to the
 * agent's session. A settled one folds to a line saying how it ended.
 */
export function ChatApprovalCard({
  request,
  onAnswer,
}: {
  request: ChatApproval;
  onAnswer: (answer: ChatApprovalAnswer) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, Answers[number]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = useRef<HTMLElement>(null);
  const open = request.state === 'open';
  // A question that opens is brought to the person: into view, and its first
  // choice focused, unless they are typing a message, which keeps the focus.
  useEffect(() => {
    if (!open) return;
    bringToQuestion(card.current, { onlyIfIdle: true });
  }, [open]);
  if (request.state !== 'open')
    return (
      <details className="mt-2 text-xs text-foreground-muted">
        <summary className="cursor-pointer">
          {settledLabel(request)} · {request.title}
        </summary>
        <p className="mt-2 whitespace-pre-wrap">{request.detail ?? request.title}</p>
      </details>
    );
  const submit = async (answer: ChatApprovalAnswer) => {
    setBusy(true);
    setError(null);
    try {
      await onAnswer(answer);
    } catch (failure) {
      setError(failureText(failure, 'The answer was not taken.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      ref={card}
      data-chat-request={request.requestId}
      className="rounded-xl border border-border bg-background-1 p-4"
    >
      <h3 className="font-medium">{request.title}</h3>
      {request.kind !== 'questions' ? (
        <>
          {request.detail && (
            <p className="mt-2 text-sm [overflow-wrap:anywhere] whitespace-pre-wrap text-foreground-muted">
              {request.detail}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {request.options.map((option) => (
              <Button
                key={option.id}
                variant={option.decision === 'accept' ? 'default' : 'outline'}
                size="sm"
                disabled={busy}
                onClick={() => void submit({ answer: option.id })}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </>
      ) : (
        <>
          {request.questions.map((question) => {
            const answer = answers[question.id] ?? {
              questionId: question.id,
              selectedOptionIds: [],
              customText: null,
            };
            const set = (next: Answers[number]) => setAnswers({ ...answers, [question.id]: next });
            return (
              <fieldset key={question.id} disabled={busy} className="mt-4 flex flex-col gap-2">
                <legend className="text-sm font-medium">{question.title || question.prompt}</legend>
                {question.title && <p className="text-sm">{question.prompt}</p>}
                {question.options.map((option) => (
                  <label
                    key={option.id}
                    className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 text-sm"
                  >
                    <input
                      type={question.multiSelect ? 'checkbox' : 'radio'}
                      name={question.id}
                      checked={answer.selectedOptionIds.includes(option.id)}
                      onChange={(event) =>
                        set({
                          ...answer,
                          customText: question.multiSelect ? answer.customText : null,
                          selectedOptionIds: question.multiSelect
                            ? event.target.checked
                              ? [...answer.selectedOptionIds, option.id]
                              : answer.selectedOptionIds.filter((id) => id !== option.id)
                            : [option.id],
                        })
                      }
                    />
                    <span>
                      {option.label}
                      {option.description && (
                        <span className="block text-foreground-muted">{option.description}</span>
                      )}
                    </span>
                  </label>
                ))}
                {question.allowCustomAnswer && (
                  <Textarea
                    aria-label={`Custom answer: ${question.title || question.prompt}`}
                    placeholder="Write your answer…"
                    value={answer.customText ?? ''}
                    onChange={(event) =>
                      set({
                        ...answer,
                        customText: event.target.value,
                        selectedOptionIds: question.multiSelect ? answer.selectedOptionIds : [],
                      })
                    }
                  />
                )}
              </fieldset>
            );
          })}
          <Button
            className="mt-3"
            size="sm"
            disabled={
              busy ||
              request.questions.some(
                (question) =>
                  !answers[question.id]?.selectedOptionIds.length &&
                  !answers[question.id]?.customText?.trim()
              )
            }
            onClick={() => void submit({ answers: Object.values(answers) })}
          >
            Submit answers
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-foreground-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * Scroll an open request's card into view and focus its first control. With
 * `onlyIfIdle`, focus moves only when the person is not typing: a message box
 * or field with text in it keeps it.
 */
export function bringToQuestion(
  card: HTMLElement | null,
  { onlyIfIdle = false }: { onlyIfIdle?: boolean } = {}
): void {
  if (!card) return;
  card.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  const active = document.activeElement;
  const typing =
    (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) &&
    active.value !== '' &&
    !card.contains(active);
  if (onlyIfIdle && typing) return;
  card
    .querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea')
    ?.focus({ preventScroll: true });
}

/** The card of an open request, by its id, if it is on screen. */
export function questionCard(requestId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-chat-request="${CSS.escape(requestId)}"]`);
}
