import type {
  Answer,
  Command,
  Snapshot,
  SessionChatClient,
} from '@switch-console/shared/session-v1';
import { useState } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { Textarea } from '@renderer/lib/ui/textarea';

type AnswerBody = Extract<Command['body'], { type: 'request.answer' }>['answer'];
export function SessionV1Request({
  request,
  client,
  connected,
}: {
  request: Snapshot['requests'][number];
  client: SessionChatClient;
  connected: boolean;
}) {
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [pending, setPending] = useState<{ id: string; answer: AnswerBody } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const result = request.result?.result;
  const decision =
    result?.kind === 'approval' && request.content.kind === 'approval'
      ? request.content.options.find((option) => option.optionId === result.optionId)?.decision
      : null;
  const settledLabel =
    decision === 'decline'
      ? 'Denied'
      : decision === 'cancel'
        ? 'Closed'
        : decision
          ? 'Approved'
          : 'Answered';
  const disabled = busy || !connected || request.state !== 'open' || pending !== null;
  const submit = async (answer: AnswerBody) => {
    const command = pending ?? { id: crypto.randomUUID(), answer };
    setPending(command);
    setBusy(true);
    setError(null);
    try {
      await client.execute(
        {
          type: 'request.answer',
          requestId: request.requestId,
          expectedRevision: request.revision,
          answer: command.answer,
        },
        command.id
      );
      setPending(null);
    } catch (error) {
      setError(String(error));
      if (!client.hasPendingCommand()) setPending(null);
    } finally {
      setBusy(false);
    }
  };
  const reconcile = async () => {
    setBusy(true);
    try {
      await client.reconcile();
      setPending(null);
      setError(null);
    } catch (error) {
      setError(String(error));
      if (!client.hasPendingCommand()) setPending(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-xl border border-border bg-background-1 p-4">
      <h3 className="font-medium">{request.content.title}</h3>
      {request.state !== 'open' && (
        <p className="mt-2 text-sm text-foreground-muted">
          {request.state === 'submitting'
            ? 'Submitting answer…'
            : request.state === 'resolved'
              ? settledLabel
              : 'Request closed'}
        </p>
      )}
      {request.content.kind === 'approval' ? (
        <>
          {request.content.detail && (
            <p className="mt-2 text-sm whitespace-pre-wrap text-foreground-muted">
              {request.content.detail}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {request.content.options.map((option) => (
              <Button
                key={option.optionId}
                variant={option.decision === 'accept' ? 'default' : 'outline'}
                size="sm"
                disabled={disabled}
                onClick={() => void submit({ kind: 'approval', optionId: option.optionId })}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </>
      ) : (
        <>
          {request.content.questions.map((question) => {
            const answer = answers[question.questionId] ?? {
              questionId: question.questionId,
              selectedOptionIds: [],
              customText: null,
            };
            return (
              <fieldset
                key={question.questionId}
                disabled={disabled}
                className="mt-4 flex flex-col gap-2"
              >
                <legend className="text-sm font-medium">{question.title || question.prompt}</legend>
                {question.title && <p className="text-sm">{question.prompt}</p>}
                {question.options.map((option) => (
                  <label
                    key={option.optionId}
                    className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 text-sm"
                  >
                    <input
                      type={question.multiSelect ? 'checkbox' : 'radio'}
                      name={question.questionId}
                      checked={answer.selectedOptionIds.includes(option.optionId)}
                      onChange={(e) =>
                        setAnswers({
                          ...answers,
                          [question.questionId]: {
                            ...answer,
                            customText: question.multiSelect ? answer.customText : null,
                            selectedOptionIds: question.multiSelect
                              ? e.target.checked
                                ? [...answer.selectedOptionIds, option.optionId]
                                : answer.selectedOptionIds.filter((id) => id !== option.optionId)
                              : [option.optionId],
                          },
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
                    onChange={(e) =>
                      setAnswers({
                        ...answers,
                        [question.questionId]: {
                          ...answer,
                          customText: e.target.value,
                          selectedOptionIds: question.multiSelect ? answer.selectedOptionIds : [],
                        },
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
              disabled ||
              request.content.questions.some(
                (q) =>
                  !answers[q.questionId]?.selectedOptionIds.length &&
                  !answers[q.questionId]?.customText?.trim()
              )
            }
            onClick={() => void submit({ kind: 'questions', answers: Object.values(answers) })}
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
      {pending && (
        <Button
          className="mt-2"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void reconcile()}
        >
          Check answer status
        </Button>
      )}
    </section>
  );
}
