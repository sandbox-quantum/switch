import type { ManualStep } from '@switch-console/core/agents/provider-setup';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { CommandActionButton, CommandRow } from './install-command-row';
import { Rich } from './rich';

/**
 * The steps an action lists for a person to take, in order, each told by its
 * description: paragraphs, and command lines to copy. The first comes with
 * `action`, the button that has Console take it, joined to its last command
 * line, or under it where it has none.
 */
export function SetupSteps({ steps, action }: { steps: ManualStep[]; action: ReactNode }) {
  if (steps.length === 0) return null;
  return (
    <div className="space-y-2">
      {steps.map((step, i) => {
        const lastCli = step.description.findLastIndex((block) => block.kind === 'cli');
        const button = i === 0 ? action : null;
        return (
          <div key={`${step.id}-${i}`} className="space-y-1">
            {steps.length > 1 && (
              <p className="text-xs text-foreground-muted">
                {i > 0 ? `Then: ${step.title}` : step.title}
              </p>
            )}
            {step.description.map((block, j) =>
              block.kind === 'cli' ? (
                <CommandRow
                  key={j}
                  command={block.command}
                  action={j === lastCli ? button : null}
                />
              ) : (
                <p key={j} className="text-xs text-foreground-muted">
                  <Rich text={block.text} />
                </p>
              )
            )}
            {lastCli === -1 && button}
          </div>
        );
      })}
    </div>
  );
}

/** The button that takes a step: `label`, with a spinner while `running`. */
export function StepButton({
  label,
  running,
  disabled,
  onClick,
}: {
  label: string;
  running: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <CommandActionButton disabled={disabled} onClick={onClick}>
      {running && <Loader2 className="size-3.5 animate-spin" />}
      {label}
    </CommandActionButton>
  );
}
