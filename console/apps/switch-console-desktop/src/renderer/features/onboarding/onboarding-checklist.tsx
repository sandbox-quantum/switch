import { Check, ChevronDown, ChevronRight, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { openExternalUrl } from '@renderer/lib/open-external';
import { SectionLabel } from '@renderer/lib/ui/label';
import { cn } from '@renderer/utils/utils';
import type { OnboardingStep, OnboardingStepId } from '@shared/core/onboarding/checklist';
import {
  SWITCH_DOCS_MESSAGING_APPS_URL,
  SWITCH_DOCS_REMOTE_HOSTING_URL,
  SWITCH_DOCS_ROOMS_URL,
} from '@shared/urls';

/**
 * The first-run setup checklist (CHOO-2022), in two shapes:
 *
 * - {@link OnboardingChecklistPanel} — the sidebar panel, collapsible and
 *   dismissible.
 * - {@link OnboardingChecklistCard} — the same list embedded in the welcome
 *   screen. It cannot be collapsed, which only makes sense against a sidebar
 *   you are reclaiming space in, but it can be dismissed: a user who has set
 *   Switch up their own way should not be told to do it again every time they
 *   land on the welcome screen.
 */

/** Where "Learn more" points. Mirrors the welcome screen's shelf. */
const LEARN_MORE_LINKS: { label: string; linkText: string; url: string }[] = [
  {
    label: 'Remote or cloud ',
    linkText: 'hosting',
    url: SWITCH_DOCS_REMOTE_HOSTING_URL,
  },
  {
    label: 'Connect to ',
    linkText: 'messaging apps',
    url: SWITCH_DOCS_MESSAGING_APPS_URL,
  },
  {
    label: 'Best ways to use ',
    linkText: 'Rooms',
    url: SWITCH_DOCS_ROOMS_URL,
  },
];

const ALL_SET_COPY = 'All set! You can now start collaborating with your agents!';

function OnboardingStepRow({
  step,
  onStart,
}: {
  step: OnboardingStep;
  onStart: (id: OnboardingStepId) => void;
}) {
  const done = step.status === 'done';
  // A step you have not reached yet is not startable: doing it out of order
  // either fails or produces something the earlier steps then contradict. It
  // stays visible — the list is meant to show what is coming — but it does not
  // pretend to be a button.
  const locked = step.status === 'upcoming';

  return (
    <button
      type="button"
      onClick={() => onStart(step.id)}
      disabled={locked}
      aria-disabled={locked}
      title={locked ? 'Finish the step above first' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm transition-colors',
        locked && 'cursor-default text-foreground-muted opacity-60',
        !locked && 'hover:bg-background-secondary-2',
        done && 'text-foreground-muted',
        step.status === 'active' && 'text-foreground'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-3.5 shrink-0 items-center justify-center rounded-full',
          done ? 'bg-foreground-success text-white' : 'border border-current opacity-60'
        )}
      >
        {done && <Check className="size-2.5" strokeWidth={3.5} />}
      </span>
      <span className={cn('truncate', done && 'line-through')}>{step.label}</span>
    </button>
  );
}

function LearnMore() {
  return (
    <div className="flex flex-col gap-1 px-1 pt-1 text-xs text-foreground-muted">
      <span>Learn more:</span>
      <ul className="flex list-disc flex-col gap-0.5 pl-4">
        {LEARN_MORE_LINKS.map((link) => (
          <li key={link.linkText}>
            {link.label}
            <button
              type="button"
              className="underline hover:text-foreground"
              onClick={() =>
                openExternalUrl(link.url, `Could not open ${link.linkText} documentation`)
              }
            >
              {link.linkText}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The list itself — steps, and the completion block once they are all done. */
function OnboardingSteps({
  steps,
  complete,
  onStart,
  showLearnMore,
}: {
  steps: OnboardingStep[];
  complete: boolean;
  onStart: (id: OnboardingStepId) => void;
  /** The welcome screen has a Learn more shelf of its own, so the completion
   * block there is the message alone rather than the same links twice. */
  showLearnMore: boolean;
}) {
  return (
    <div className="flex flex-col">
      {steps.map((step) => (
        <OnboardingStepRow key={step.id} step={step} onStart={onStart} />
      ))}
      {complete && (
        <>
          <p className="px-1 pt-2 text-sm text-foreground-success">{ALL_SET_COPY}</p>
          {showLearnMore && <LearnMore />}
        </>
      )}
    </div>
  );
}

/**
 * The sidebar panel. Collapsing hides the steps but keeps the header; the ✕
 * dismisses the checklist altogether, which is a setting so it can be undone
 * from Settings → General once the panel is no longer there to undo it from.
 */
export const OnboardingChecklistPanel = observer(function OnboardingChecklistPanel({
  steps,
  complete,
  collapsed,
  onStart,
  onToggleCollapsed,
  onDismiss,
}: {
  steps: OnboardingStep[];
  complete: boolean;
  collapsed: boolean;
  onStart: (id: OnboardingStepId) => void;
  onToggleCollapsed: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex flex-col border-t border-border px-2 py-2">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-foreground-tertiary-passive hover:text-foreground-tertiary"
          aria-label={collapsed ? 'Expand setup checklist' : 'Collapse setup checklist'}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <ChevronRight className="size-3.5 shrink-0" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0" />
          )}
          <SectionLabel className="text-foreground-tertiary-passive">
            Setting up Switch
          </SectionLabel>
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss setup checklist"
          className="rounded-md p-0.5 text-foreground-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {!collapsed && (
        <div className="pt-1">
          <OnboardingSteps steps={steps} complete={complete} onStart={onStart} showLearnMore />
        </div>
      )}
    </div>
  );
});

/**
 * The welcome-screen embed: the same list, framed as a card. The ✕ sets the
 * same setting the sidebar's does, so dismissing it in one place dismisses it
 * in both and Settings → General brings it back.
 */
export function OnboardingChecklistCard({
  steps,
  complete,
  onStart,
  onDismiss,
}: {
  steps: OnboardingStep[];
  complete: boolean;
  onStart: (id: OnboardingStepId) => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex w-full flex-col gap-2 rounded-xl border border-border p-4">
      <div className="flex items-center justify-between">
        <SectionLabel className="text-foreground-tertiary-passive">Setting up Switch</SectionLabel>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss setup checklist"
          className="rounded-md p-0.5 text-foreground-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <OnboardingSteps steps={steps} complete={complete} onStart={onStart} showLearnMore={false} />
    </div>
  );
}
