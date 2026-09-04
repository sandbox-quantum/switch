import type { ApprovalDecision } from '@switch-console/agent-providers';
import { ShieldQuestionMark } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import type { SessionTranscriptStore } from '@renderer/features/sessions/stores/session-transcript-store';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { Button } from '@renderer/lib/ui/button';
import { log } from '@renderer/utils/logger';
import type { TranscriptEntry } from '@shared/core/sessions/session-transcript';

type ApprovalEntry = Extract<TranscriptEntry, { kind: 'request' }>;

const DECISION_LABELS: Record<ApprovalDecision, string> = {
  accept: 'Approved',
  acceptForSession: 'Approved for this session',
  decline: 'Declined',
  cancel: 'Cancelled',
};

/**
 * An approval the provider is blocked on: what it wants to do, and the choices
 * it offered. Resolved cards stay in place showing the decision — the record of
 * what was allowed is the point, so they are not removed once answered.
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
      className="rounded-lg border border-border-warning bg-background-warning/40 px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
        <ShieldQuestionMark className="mt-0.5 size-4 shrink-0 text-foreground-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{entry.title}</p>
          {entry.detail && (
            <pre className="mt-1.5 max-h-40 overflow-auto rounded-md border border-border bg-background px-2 py-1.5 font-mono text-tiny whitespace-pre-wrap text-foreground-muted">
              {entry.detail}
            </pre>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {entry.options.map((option) => (
              <Button
                key={option.decision}
                size="xs"
                variant={option.decision === 'accept' ? 'default' : 'outline'}
                disabled={resolved || submitting !== null}
                onClick={() => void respond(option.decision)}
              >
                {option.label}
              </Button>
            ))}
            {resolved && (
              <span className="ml-1 text-tiny text-foreground-passive">
                {entry.decision ? DECISION_LABELS[entry.decision] : 'Resolved'}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
