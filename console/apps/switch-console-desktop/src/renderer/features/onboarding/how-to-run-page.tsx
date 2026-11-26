import { Check, Cloud, Globe, Laptop } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@switch-console/chat-ui/primitives/button';
import { OnboardingSurface, useWizardExit } from '@renderer/lib/ui/wizard-frame';
import { cn } from '@renderer/utils/utils';

type Choice = 'local' | 'external';

/**
 * Where Switch runs: the two ways of running it yourself that work without
 * anything set up beforehand, then Switch Cloud, shown as coming soon.
 *
 * Switch Cloud is not open to first runs yet, whatever the build has been
 * told about it: its card is last, greyed out and disabled, so it cannot be
 * focused, clicked or preselected, and nothing on this page starts the Cloud
 * path. The page does not even take the Cloud's configuration, so no state
 * the flow holds can bring that path back.
 *
 * Running the stack on a remote host is left to the Add server dialog: it
 * needs an SSH host onboarded first, which is a detour a first run should not
 * take.
 */
export function HowToRunPage({
  onBack,
  onLocal,
  onExternal,
}: {
  onBack: () => void;
  onLocal: () => void;
  onExternal: () => void;
}) {
  const exit = useWizardExit();
  const [chosen, setChosen] = useState<Choice>('local');

  const onContinue = () => {
    if (chosen === 'local') onLocal();
    else onExternal();
  };

  return (
    <OnboardingSurface
      exit={exit}
      footer={
        <>
          <Button variant="outline" onClick={onBack}>
            Back
          </Button>
          <Button onClick={onContinue}>Continue</Button>
        </>
      }
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold">How do you want to run Switch Rooms?</h1>
        <p className="text-sm text-foreground-muted">
          You can’t change this later without moving your workspace, so pick what fits your team.
        </p>
      </div>

      <div className="flex flex-col gap-4" role="radiogroup" aria-label="How to run Switch Rooms">
        <div className="grid gap-3 sm:grid-cols-2">
          <SmallCard
            icon={<Laptop className="size-5" />}
            title="On this computer"
            description="Switch Console installs the Switch server on this computer and keeps it updated."
            selected={chosen === 'local'}
            onSelect={() => setChosen('local')}
          />
          <SmallCard
            icon={<Globe className="size-5" />}
            title="Join an existing server"
            description="Connect to a Switch server your team already runs. You’ll need its address."
            selected={chosen === 'external'}
            onSelect={() => setChosen('external')}
          />
        </div>
        <CloudComingSoonCard />
      </div>
    </OnboardingSurface>
  );
}

/**
 * Switch Cloud, as a choice that is not open yet. A disabled button is left
 * out of the tab order and ignores clicks, Enter and Space; it has no handler
 * to call in any case.
 */
function CloudComingSoonCard() {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={false}
      disabled
      aria-disabled
      className="flex w-full cursor-not-allowed items-start gap-4 rounded-xl border border-border bg-background/80 p-4 text-left opacity-60"
    >
      <span className="flex size-20 shrink-0 items-center justify-center rounded-lg bg-background-tertiary text-foreground-muted">
        <Cloud className="size-7" />
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-center gap-2">
          <span className="text-base font-medium text-foreground">Switch Cloud</span>
          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-foreground-muted">
            Coming soon
          </span>
        </span>
        <span className="block text-sm text-foreground-muted">
          Managed hosting for your Switch server and agents. Coming soon - self-host to get started
          today.
        </span>
      </span>
    </button>
  );
}

function SmallCard({
  icon,
  title,
  description,
  selected,
  onSelect,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'relative flex min-h-36 flex-col gap-6 rounded-xl border bg-background/80 p-4 text-left',
        selected ? 'border-foreground' : 'border-border hover:bg-[var(--sel-soft)]'
      )}
    >
      <span className="text-foreground-muted">{icon}</span>
      <span className="space-y-1">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="block text-xs text-foreground-muted">{description}</span>
      </span>
      {selected && (
        <span className="absolute top-3 right-3">
          <SelectedMark />
        </span>
      )}
    </button>
  );
}

function SelectedMark() {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
      <Check className="size-3.5" />
    </span>
  );
}
