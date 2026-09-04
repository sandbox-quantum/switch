import type { ApprovalDecision } from '@switch-console/agent-providers';
import { Check, CircleSlash, ShieldQuestionMark, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import type { SessionTranscriptStore } from '@renderer/features/sessions/stores/session-transcript-store';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { Button } from '@renderer/lib/ui/button';
import { log } from '@renderer/utils/logger';
import { cn } from '@renderer/utils/utils';
import type { TranscriptEntry } from '@shared/core/sessions/session-transcript';

type ApprovalEntry = Extract<TranscriptEntry, { kind: 'request' }>;

const DECISION_LABELS: Record<ApprovalDecision, string> = {
  accept: 'Approved',
  acceptForSession: 'Approved for this session',
  decline: 'Declined',
  cancel: 'Cancelled',
};

/** Allowed, refused, or neither — readable before the words are. */
const DECISION_ICONS: Record<ApprovalDecision, { icon: typeof Check; className: string }> = {
  accept: { icon: Check, className: 'text-foreground-success' },
  acceptForSession: { icon: Check, className: 'text-foreground-success' },
  decline: { icon: X, className: 'text-foreground-destructive' },
  cancel: { icon: CircleSlash, className: 'text-foreground-passive' },
};

/**
 * An approval the provider is blocked on: what it wants to do, and the choices
 * it offered. Resolved cards stay in place showing the decision — the record of
 * what was allowed is the point, so they are not removed once answered.
 *
 * Once answered the options go entirely, rather than staying on as disabled
 * buttons: a row of choices next to a small "Approved" reads as a decision
 * still to make, and the one that was made is the only thing left to say.
 */
export const ApprovalCard = observer(function ApprovalCard({
  entry,
  store,
}: {
  entry: ApprovalEntry;
  store: SessionTranscriptStore;
}) {
  const [submitting, setSubmitting] = useState<ApprovalDecision | null>(null);
  const resolved = entry.state === 'resolved';
  const { icon: Icon, className: iconClass } = entry.decision
    ? DECISION_ICONS[entry.decision]
    : DECISION_ICONS.cancel;
  // The label the person actually chose, so the card says "Allow once" where
  // that is what was clicked rather than collapsing it to "Approved".
  const chosen = entry.options.find((option) => option.decision === entry.decision)?.label;
  const outcome = [
    chosen ?? (entry.decision ? DECISION_LABELS[entry.decision] : 'Resolved'),
    entry.decidedBy === 'room'
      ? 'from room'
      : entry.decidedBy === 'console'
        ? 'from console'
        : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const respond = async (decision: ApprovalDecision) => {
    setSubmitting(decision);
    try {
      await store.respondToRequest(entry.id, decision);
    } catch (error) {
      log.error('Failed to answer an approval request', { requestId: entry.id, error });
      const { headline, detail } = describeFailure(error, 'Could not send the decision.');
      toast({ title: headline, description: detail ?? undefined, variant: 'destructive' });
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div
      role="group"
      aria-label={`Approval request: ${entry.title}`}
      className={cn(
        'rounded-lg border px-3 py-2.5',
        resolved
          ? 'border-border bg-background-1'
          : 'border-border-warning bg-background-warning/40'
      )}
    >
      <div className="flex items-start gap-2">
        {resolved ? (
          <Icon className={cn('mt-0.5 size-4 shrink-0', iconClass)} />
        ) : (
          <ShieldQuestionMark className="mt-0.5 size-4 shrink-0 text-foreground-warning" />
        )}
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'text-sm font-medium',
              resolved ? 'text-foreground-muted' : 'text-foreground'
            )}
          >
            {entry.title}
          </p>
          {entry.detail && (
            <pre className="mt-1.5 max-h-40 overflow-auto rounded-md border border-border bg-background px-2 py-1.5 font-mono text-tiny whitespace-pre-wrap text-foreground-muted">
              {entry.detail}
            </pre>
          )}
          {resolved ? (
            <p className="mt-1.5 text-xs text-foreground-passive">{outcome}</p>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {entry.options.map((option) => (
                <Button
                  key={option.decision}
                  size="xs"
                  variant={option.decision === 'accept' ? 'default' : 'outline'}
                  disabled={submitting !== null}
                  onClick={() => void respond(option.decision)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
