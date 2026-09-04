import { MessageCircleQuestionMark } from 'lucide-react';
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
import type { TranscriptEntry } from '@shared/core/sessions/session-transcript';
import { draftsToAnswers, emptyDraft, type QuestionDraft } from './transcript-inputs';

type QuestionEntry = Extract<TranscriptEntry, { kind: 'question' }>;

export const QuestionCard = observer(function QuestionCard({
  entry,
  store,
}: {
  entry: QuestionEntry;
  store: SessionTranscriptStore;
}) {
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  const [submitting, setSubmitting] = useState(false);
  const resolved = entry.state === 'resolved';

  const draftFor = (id: string) => drafts[id] ?? emptyDraft();
  const setDraft = (id: string, next: Partial<QuestionDraft>) =>
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? emptyDraft()), ...next } }));

  const answers = draftsToAnswers(entry.questions, drafts);

  const submit = async () => {
    if (!answers) return;
    setSubmitting(true);
    try {
      await store.respondToUserInput(entry.id, answers);
    } catch (error) {
      log.error('Failed to answer a question', { requestId: entry.id, error });
      const { headline, detail } = describeFailure(error, 'Could not send the answer.');
      toast({ title: headline, description: detail ?? undefined, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="group"
      aria-label="Question from the agent"
      className="rounded-lg border border-border-info bg-background-info/40 px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
        <MessageCircleQuestionMark className="mt-0.5 size-4 shrink-0 text-foreground-info" />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {entry.questions.map((question) => {
            const draft = draftFor(question.id);
            const answered = resolved ? entry.answers?.[question.id] : undefined;
            return (
              <fieldset key={question.id} className="min-w-0" disabled={resolved || submitting}>
                {question.header && (
                  <legend className="text-tiny font-medium tracking-wide text-foreground-muted uppercase">
                    {question.header}
                  </legend>
                )}
                <p className="mt-0.5 text-sm text-foreground">{question.question}</p>
                {question.multiSelect ? (
                  <div className="mt-2 flex flex-col gap-2">
                    {question.options.map((option) => (
                      <Label
                        key={option.value}
                        className="flex items-start gap-2 text-xs font-normal"
                      >
                        <Checkbox
                          checked={draft.selected.includes(option.value)}
                          onCheckedChange={(checked) =>
                            setDraft(question.id, {
                              selected: checked
                                ? [...draft.selected, option.value]
                                : draft.selected.filter((value) => value !== option.value),
                            })
                          }
                        />
                        <span className="min-w-0">
                          {option.label}
                          {option.description && (
                            <span className="block text-tiny text-foreground-passive">
                              {option.description}
                            </span>
                          )}
                        </span>
                      </Label>
                    ))}
                  </div>
                ) : (
                  <RadioGroup
                    className="mt-2 gap-2"
                    value={draft.selected[0] ?? null}
                    onValueChange={(value) =>
                      setDraft(question.id, { selected: value ? [String(value)] : [] })
                    }
                  >
                    {question.options.map((option) => (
                      <Label
                        key={option.value}
                        className="flex items-start gap-2 text-xs font-normal"
                      >
                        <RadioGroupItem value={option.value} />
                        <span className="min-w-0">
                          {option.label}
                          {option.description && (
                            <span className="block text-tiny text-foreground-passive">
                              {option.description}
                            </span>
                          )}
                        </span>
                      </Label>
                    ))}
                  </RadioGroup>
                )}
                {question.allowCustomAnswer && (
                  <Input
                    className="mt-2 h-7 text-xs"
                    placeholder="Other…"
                    aria-label="Other answer"
                    value={draft.custom}
                    onChange={(event) => setDraft(question.id, { custom: event.target.value })}
                  />
                )}
                {resolved && answered !== undefined && (
                  <p className="mt-1.5 text-tiny text-foreground-passive">
                    Answered: {Array.isArray(answered) ? answered.join(', ') : answered}
                  </p>
                )}
              </fieldset>
            );
          })}
          {!resolved && (
            <div>
              <Button
                size="xs"
                disabled={!answers || submitting}
                onClick={() => void submit()}
                aria-label="Submit answers"
              >
                Submit
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
