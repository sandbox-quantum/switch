import { DialogHeader, DialogTitle } from './dialog';

/**
 * A dialog header that says where in a sequence you are.
 *
 * The count is only honest once the sequence has a fixed length, so a step that
 * might or might not be reached must not be counted — a wizard that renumbers
 * itself halfway through is worse than one that never numbered itself at all.
 */
export function WizardStepHeader({ title, step, of }: { title: string; step: number; of: number }) {
  return (
    <DialogHeader className="flex-col items-start gap-1">
      <DialogTitle>{title}</DialogTitle>
      <p className="text-xs text-foreground-muted">
        Step {step} of {of}
      </p>
    </DialogHeader>
  );
}
