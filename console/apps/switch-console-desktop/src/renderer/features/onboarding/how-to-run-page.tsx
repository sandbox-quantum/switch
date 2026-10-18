import { Check, Cloud, Globe, Laptop } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { OnboardingSurface, useWizardExit } from '@renderer/lib/ui/wizard-frame';
import { cn } from '@renderer/utils/utils';

/**
 * What the page can say about Switch Cloud, and what choosing it does.
 *
 * `connecting` and `error` belong to the attempt, not to the configuration: the
 * page stays up while the server is registered, and a failure is shown on the
 * card that was chosen rather than somewhere the eye has already left.
 */
export type CloudChoiceState =
  | { kind: 'reading' }
  | { kind: 'closed' }
  | { kind: 'failed'; headline: string; detail: string | null }
  | {
      kind: 'open';
      url: string;
      connecting: boolean;
      error: string | null;
      onConnect: () => void;
    };

type Choice = 'cloud' | 'local' | 'external';

/**
 * Where Switch runs: Switch Cloud, recommended and on top, then the two ways
 * of running it yourself that work without anything set up beforehand.
 *
 * Running the stack on a remote host is left to the Add server dialog: it
 * needs an SSH host onboarded first, which is a detour a first run should not
 * take.
 *
 * A build that has not been told where the Cloud is does not show its card,
 * and one whose Cloud configuration could not be read shows it as unavailable,
 * in words as well as in grey.
 */
export function HowToRunPage({
  cloud,
  onBack,
  onLocal,
  onExternal,
}: {
  cloud: CloudChoiceState;
  onBack: () => void;
  onLocal: () => void;
  onExternal: () => void;
}) {
  const exit = useWizardExit();
  const cloudOpen = cloud.kind === 'open';
  // Nothing picked yet follows the Cloud's availability, which is read after
  // the page first draws: the Cloud once it turns out to be open.
  const [picked, setPicked] = useState<Choice | null>(null);
  const chosen: Choice =
    picked === null || (picked === 'cloud' && !cloudOpen)
      ? cloudOpen
        ? 'cloud'
        : 'local'
      : picked;
  const connecting = cloudOpen && cloud.connecting;

  const onContinue = () => {
    if (chosen === 'cloud' && cloudOpen) cloud.onConnect();
    else if (chosen === 'local') onLocal();
    else if (chosen === 'external') onExternal();
  };

  return (
    <OnboardingSurface
      exit={exit}
      footer={
        <>
          <Button variant="outline" onClick={onBack} disabled={connecting}>
            Back
          </Button>
          <Button onClick={onContinue} disabled={connecting}>
            {connecting && <Spinner className="size-3.5" />}
            Continue
          </Button>
        </>
      }
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold">How do you want to run Switch?</h1>
        <p className="text-sm text-foreground-muted">
          You can’t change this later without moving your workspace, so pick what fits your team.
        </p>
      </div>

      <div className="flex flex-col gap-4" role="radiogroup" aria-label="How to run Switch">
        <CloudCard
          cloud={cloud}
          selected={chosen === 'cloud'}
          onSelect={() => setPicked('cloud')}
        />
        <p className="text-center text-sm text-foreground-muted">or run your own server</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <SmallCard
            icon={<Laptop className="size-5" />}
            title="On this computer"
            description="Switch Console installs the Switch server on this computer and keeps it updated."
            selected={chosen === 'local'}
            disabled={connecting}
            onSelect={() => setPicked('local')}
          />
          <SmallCard
            icon={<Globe className="size-5" />}
            title="Join an existing server"
            description="Connect to a Switch server your team already runs. You’ll need its address."
            selected={chosen === 'external'}
            disabled={connecting}
            onSelect={() => setPicked('external')}
          />
        </div>
      </div>
    </OnboardingSurface>
  );
}

function CloudCard({
  cloud,
  selected,
  onSelect,
}: {
  cloud: CloudChoiceState;
  selected: boolean;
  onSelect: () => void;
}) {
  // Always on the page, so the question looks the same in every build: a
  // build that has not been told where the Cloud is says it is coming, greyed
  // out, rather than leaving a gap; one still reading its configuration shows
  // the card without a choice yet.
  const unavailable = cloud.kind !== 'open';
  const badge =
    cloud.kind === 'failed'
      ? 'Unavailable'
      : cloud.kind === 'open'
        ? 'Recommended'
        : cloud.kind === 'closed'
          ? 'Coming soon'
          : null;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={unavailable || (cloud.kind === 'open' && cloud.connecting)}
      aria-disabled={unavailable}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-4 rounded-xl border bg-background/80 p-4 text-left',
        selected ? 'border-foreground' : 'border-border hover:bg-[var(--sel-soft)]',
        unavailable && 'opacity-60'
      )}
    >
      <span className="flex size-20 shrink-0 items-center justify-center rounded-lg bg-background-tertiary text-foreground-muted">
        <Cloud className="size-7" />
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-center gap-2">
          <span className="text-base font-medium text-foreground">Switch Cloud</span>
          {badge && (
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-foreground-muted">
              {badge}
            </span>
          )}
        </span>
        {cloud.kind === 'failed' ? (
          <span className="block text-sm text-foreground-muted">
            {cloud.headline}
            {cloud.detail ? ` ${cloud.detail}` : ''}
          </span>
        ) : cloud.kind === 'closed' ? (
          <span className="block text-sm text-foreground-muted">
            We’ll run the server for you. Not open yet: run your own server below for now.
          </span>
        ) : (
          <span className="block text-sm text-foreground-muted">
            We run the server for you. Sign up in a minute.
          </span>
        )}
        {cloud.kind === 'open' && cloud.error && (
          <span role="alert" className="block text-sm text-destructive">
            {cloud.error}
          </span>
        )}
      </span>
      {selected && <SelectedMark />}
    </button>
  );
}

function SmallCard({
  icon,
  title,
  description,
  selected,
  disabled,
  onSelect,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'relative flex min-h-36 flex-col gap-6 rounded-xl border bg-background/80 p-4 text-left disabled:opacity-60',
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
