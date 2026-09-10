import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleSlash,
  Loader2,
  MessageCircleQuestionMark,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import type { SessionTranscriptStore } from '@renderer/features/sessions/stores/session-transcript-store';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { Input } from '@renderer/lib/ui/input';
import { Label } from '@renderer/lib/ui/label';
import { RadioGroup, RadioGroupItem } from '@renderer/lib/ui/radio-group';
import { log } from '@renderer/utils/logger';
import { cn } from '@renderer/utils/utils';
import type { TranscriptEntry } from '@shared/core/sessions/session-transcript';
import {
  draftToAnswer,
  draftsToAnswers,
  emptyDraft,
  type QuestionDraft,
} from './transcript-inputs';

type QuestionEntry = Extract<TranscriptEntry, { kind: 'question' }>;

export const QuestionCard = observer(function QuestionCard({
  entry,
  store,
}: {
  entry: QuestionEntry;
  store: SessionTranscriptStore;
}) {
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  const [index, setIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const setDraft = (id: string, next: Partial<QuestionDraft>) =>
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? emptyDraft()), ...next } }));
  const answers = draftsToAnswers(entry.questions, drafts);
  const submit = async () => {
    if (!answers || submitting) return;
    setSubmitting(true);
    try {
      await store.respondToUserInput(entry.id, answers);
    } catch (error) {
      log.error('Failed to answer an agent question', { requestId: entry.id, error });
      const { headline, detail } = describeFailure(error, 'Could not send the answers.');
      toast({ title: headline, description: detail ?? undefined, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  if (entry.state === 'resolved') {
    return (
      <details className="group rounded-lg border border-border bg-background-1 px-3 py-2">
        <summary className="flex cursor-pointer items-center gap-2 text-xs text-foreground-muted">
          {entry.answers ? (
            <Check className="size-3.5 shrink-0" />
          ) : (
            <CircleSlash className="size-3.5 shrink-0" />
          )}
          <span>{entry.answers ? 'Answers sent' : 'Question closed'}</span>
          <span className="ml-auto text-tiny text-foreground-passive">View details</span>
        </summary>
        <dl className="mt-3 space-y-3 text-sm">
          {entry.questions.map((question) => {
            const answer = entry.answers?.[question.id];
            const values = Array.isArray(answer) ? answer : answer === undefined ? [] : [answer];
            return (
              <div key={question.id}>
                <dt className="text-foreground-muted">{question.question}</dt>
                <dd className="mt-1 break-words text-foreground">
                  {values.length
                    ? values
                        .map(
                          (value) =>
                            question.options.find((option) => option.value === value)?.label ??
                            value
                        )
                        .join(', ')
                    : 'Not answered'}
                </dd>
              </div>
            );
          })}
        </dl>
      </details>
    );
  }

  const question = entry.questions[index];
  if (!question)
    return (
      <p role="alert" className="p-4 text-sm text-foreground-destructive">
        The agent sent a question with no content.
      </p>
    );
  const draft = drafts[question.id] ?? emptyDraft();
  const last = index === entry.questions.length - 1;
  const hasAnswer = draftToAnswer(question, draft) !== null;
  const optionClass = (selected: boolean) =>
    cn(
      'flex w-full cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm font-normal transition-colors has-focus-visible:ring-2 has-focus-visible:ring-primary/30',
      selected
        ? 'border-border-primary bg-background-1'
        : 'border-transparent hover:bg-background-1'
    );

  return (
    <div role="group" aria-label="Question from the agent" className="p-4">
      <div className="mb-3 flex items-center gap-2 text-xs text-foreground-muted">
        <MessageCircleQuestionMark className="size-4 shrink-0" />
        <span className="font-medium">{question.header || 'A question for you'}</span>
        <span className="ml-auto tabular-nums">
          {index + 1} of {entry.questions.length}
        </span>
      </div>
      <fieldset key={question.id} disabled={submitting} className="min-w-0">
        <legend className="mb-1 text-sm leading-relaxed font-medium text-foreground">
          {question.question}
        </legend>
        <p className="mb-2 text-xs text-foreground-passive">
          {question.multiSelect ? 'Choose one or more options.' : 'Choose one option.'}
        </p>
        {question.multiSelect ? (
          <div className="space-y-1">
            {question.options.map((option) => (
              <Label
                key={option.value}
                className={optionClass(draft.selected.includes(option.value))}
              >
                <Checkbox
                  className="mt-0.5"
                  checked={draft.selected.includes(option.value)}
                  onCheckedChange={(checked) =>
                    setDraft(question.id, {
                      selected: checked
                        ? [...draft.selected, option.value]
                        : draft.selected.filter((value) => value !== option.value),
                    })
                  }
                />
                <span className="min-w-0 break-words">
                  {option.label}
                  {option.description && (
                    <span className="mt-0.5 block text-xs leading-relaxed text-foreground-muted">
                      {option.description}
                    </span>
                  )}
                </span>
              </Label>
            ))}
          </div>
        ) : (
          <RadioGroup
            className="gap-1"
            value={draft.custom.trim() ? null : (draft.selected[0] ?? null)}
            onValueChange={(value) =>
              setDraft(question.id, { selected: value ? [String(value)] : [], custom: '' })
            }
          >
            {question.options.map((option) => (
              <Label
                key={option.value}
                className={optionClass(
                  !draft.custom.trim() && draft.selected.includes(option.value)
                )}
              >
                <RadioGroupItem className="mt-0.5" value={option.value} />
                <span className="min-w-0 break-words">
                  {option.label}
                  {option.description && (
                    <span className="mt-0.5 block text-xs leading-relaxed text-foreground-muted">
                      {option.description}
                    </span>
                  )}
                </span>
              </Label>
            ))}
          </RadioGroup>
        )}
        {question.allowCustomAnswer && (
          <Label className="mt-3 flex flex-col items-stretch gap-1.5 text-xs font-normal text-foreground-muted">
            {question.multiSelect ? 'Add another answer' : 'Or write your own answer'}
            <Input
              value={draft.custom}
              placeholder="Your answer…"
              onChange={(event) =>
                setDraft(question.id, {
                  custom: event.target.value,
                  ...(!question.multiSelect ? { selected: [] } : {}),
                })
              }
            />
          </Label>
        )}
      </fieldset>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <span className="text-tiny text-foreground-passive">
          Review your choices before sending.
        </span>
        <div className="ml-auto flex gap-2">
          {index > 0 && (
            <Button
              size="sm"
              variant="ghost"
              disabled={submitting}
              onClick={() => setIndex(index - 1)}
            >
              <ArrowLeft />
              Back
            </Button>
          )}
          <Button
            size="sm"
            disabled={submitting || (last ? !answers : !hasAnswer)}
            onClick={() => (last ? void submit() : setIndex(index + 1))}
            aria-label={last ? 'Submit answers' : 'Next question'}
          >
            {submitting ? <Loader2 className="animate-spin" /> : last ? <Check /> : <ArrowRight />}
            {submitting ? 'Sending…' : last ? 'Send answers' : 'Next'}
          </Button>
        </div>
      </div>
    </div>
  );
});
