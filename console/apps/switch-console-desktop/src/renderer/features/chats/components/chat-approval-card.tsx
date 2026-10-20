import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { Button } from '@renderer/lib/ui/button';
import { Textarea } from '@renderer/lib/ui/textarea';
import type { ChatApproval, ChatApprovalAnswer } from '@shared/core/chats/activity';

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
    <section className="rounded-xl border border-border bg-background-1 p-4">
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
