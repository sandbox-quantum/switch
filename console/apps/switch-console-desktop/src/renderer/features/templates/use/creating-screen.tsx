import { Check, Circle, Loader2, TriangleAlert } from 'lucide-react';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/utils/utils';
import type { CreateStep, CreateStepStatus } from './use-template-model';

function StepIcon({ status }: { status: CreateStepStatus }) {
  if (status === 'running') return <Loader2 className="size-4 animate-spin text-foreground" />;
  if (status === 'done')
    return (
      <span className="flex size-4 items-center justify-center rounded-full bg-emerald-600 text-white dark:bg-emerald-500">
        <Check className="size-2.5" strokeWidth={3.5} />
      </span>
    );
  if (status === 'failed') return <TriangleAlert className="size-4 text-destructive" />;
  return <Circle className="size-4 text-foreground-passive opacity-50" />;
}

const STATUS_WORD: Record<CreateStepStatus, string> = {
  waiting: 'waiting',
  running: 'working',
  done: 'done',
  failed: 'failed',
};

/**
 * Shown in place of the form from the moment Create is pressed: the steps
 * of the run, how far it is, and, when a step fails, the way on. The form
 * is out of reach while it shows, so a half-made template cannot be edited
 * underneath a run.
 */
export function CreatingScreen({
  templateName,
  phase,
  steps,
  error,
  doneDetail,
  onRetry,
  onBack,
}: {
  templateName: string;
  phase: 'creating' | 'done' | 'failed';
  steps: CreateStep[];
  error: string | null;
  /** Where the page goes next, shown under the finished heading. */
  doneDetail: string | null;
  onRetry: () => void;
  onBack: () => void;
}) {
  const done = steps.filter((s) => s.status === 'done').length;
  const progress = phase === 'done' ? 1 : steps.length === 0 ? 0 : done / steps.length;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center overflow-auto px-8 py-14"
      role="status"
      aria-live="polite"
    >
      <div className="flex w-full max-w-[440px] flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          {phase === 'done' && (
            <span className="flex size-11 animate-in items-center justify-center rounded-full bg-emerald-600 text-white duration-300 zoom-in-50 motion-reduce:animate-none dark:bg-emerald-500">
              <Check className="size-6" strokeWidth={3} />
            </span>
          )}
          <h3 className="text-lg font-semibold tracking-tight">
            {phase === 'done'
              ? `${templateName} is ready`
              : phase === 'failed'
                ? 'Stopped at one step'
                : `Creating ${templateName}`}
          </h3>
          <p className="text-[13px] text-foreground-muted">
            {phase === 'done'
              ? (doneDetail ?? 'Opening it…')
              : phase === 'failed'
                ? done > 0
                  ? 'What was created stays created.'
                  : 'Nothing was created.'
                : 'This takes a few seconds.'}
          </p>
        </div>

        <div className="h-1 overflow-hidden rounded-full bg-background-2">
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none',
              phase === 'failed' ? 'bg-destructive' : 'bg-emerald-600 dark:bg-emerald-500'
            )}
            style={{ width: `${Math.max(progress, 0.04) * 100}%` }}
          />
        </div>

        <ul className="flex flex-col divide-y divide-border rounded-[10px] border border-border bg-background">
          {steps.map((step) => (
            <li key={step.key} className="flex flex-col gap-1 px-3.5 py-2.5">
              <div className="flex items-center gap-3">
                <StepIcon status={step.status} />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-[13px]',
                    step.status === 'waiting' ? 'text-foreground-muted' : 'text-foreground'
                  )}
                >
                  {step.label}
                </span>
                <span
                  className={cn(
                    'shrink-0 text-[11px]',
                    step.status === 'failed' ? 'text-destructive' : 'text-foreground-passive'
                  )}
                >
                  {STATUS_WORD[step.status]}
                </span>
              </div>
              {step.warning && (
                <p className="pl-7 text-[11.5px] text-amber-700 dark:text-amber-400">
                  {step.warning}
                </p>
              )}
            </li>
          ))}
        </ul>

        {phase === 'failed' && (
          <div className="flex flex-col gap-3">
            {error && <p className="text-[13px] text-destructive">{error}</p>}
            <div className="flex items-center justify-center gap-2">
              <Button size="sm" onClick={onRetry}>
                Retry remaining steps
              </Button>
              <Button size="sm" variant="outline" onClick={onBack}>
                Back to the form
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
