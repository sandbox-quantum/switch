import { CircleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { UiEntryPoint } from '@shared/core/telemetry/reporting';
import { ComputerNote, ProviderCard, SelectedPanel } from './provider-cards';
import { addFailedLine, ThisComputerAsk } from './this-computer-ask';
import { useProviderSetup } from './use-provider-setup';
import type { ThisComputer } from './use-this-computer';

/**
 * Pick the AI provider switch-buddy runs on, get it ready on this computer,
 * and create the buddy with it (see `useProviderSetup`).
 *
 * `thisComputer` is the page's own `useThisComputer`, so a page that already
 * follows this computer does not set it up a second time.
 *
 * A computer that is not a machine of the workspace yet is not made one by
 * opening this (B38): it is told what adding it does, and added only when
 * the person presses "Add this computer". Declining is the surface's own Not
 * now (or Skip for now, or Back).
 */
export const ProviderSetup = observer(function ProviderSetup({
  serverId,
  workspaceId,
  entryPoint,
  onCreated,
  thisComputer,
}: {
  serverId: string;
  workspaceId: string;
  /** Where this card is shown: the first run, or the buddy's chat later. */
  entryPoint: UiEntryPoint;
  onCreated: (agent: { agentId: string; name: string }) => void;
  thisComputer: {
    state: ThisComputer;
    recheck: () => Promise<string | null>;
    /** The person's yes: makes this computer a machine of the workspace (B38). */
    allow?: () => Promise<void>;
    /** Their agents run on a shared-cloud box: what the ask says about the rest. */
    sharedCloud?: boolean;
  };
}) {
  const computer = thisComputer.state;
  const setup = useProviderSetup({
    serverId,
    workspaceId,
    entryPoint,
    onCreated,
    computer,
    recheck: thisComputer.recheck,
  });
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const add = async () => {
    setAdding(true);
    setAddError(null);
    try {
      await thisComputer.allow?.();
    } catch (cause) {
      setAddError(addFailedLine(failureText(cause, 'It could not be set up to run agents.')));
    } finally {
      setAdding(false);
    }
  };

  if (computer.kind === 'needs-permission')
    return (
      <div className="flex flex-col items-center gap-3">
        <ThisComputerAsk sharedCloud={thisComputer.sharedCloud ?? false} action="add" />
        <Button onClick={() => void add()} disabled={adding}>
          {adding && <Spinner className="size-3.5" />}
          {adding ? 'Adding this computer…' : 'Add this computer'}
        </Button>
        {addError && (
          <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{addError}</span>
          </p>
        )}
      </div>
    );

  return (
    <div className="flex flex-col gap-4">
      <ComputerNote computer={computer} />
      <p className="text-sm text-foreground">Pick an AI provider to power switch-buddy:</p>
      <ul className="grid gap-3 sm:grid-cols-3">
        {setup.providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            selected={setup.selected?.id === provider.id}
            disabled={setup.busy !== null || (setup.login !== null && setup.login.ended === null)}
            onSelect={() => setup.pick(provider.id)}
          />
        ))}
      </ul>

      {setup.selected && computer.kind === 'ready' && (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-background/80 p-4">
          <SelectedPanel
            provider={setup.selected}
            login={setup.login?.providerId === setup.selected.id ? setup.login : null}
            busy={setup.busy}
            onStart={() => setup.start(setup.selected!)}
            onSignIn={() => void setup.signIn(setup.selected!)}
            onCancelSignIn={setup.cancelSignIn}
            checked={setup.checked}
            onInstall={() => void setup.install(setup.selected!)}
            onCheckAgain={() => void setup.checkAgain()}
          />
        </div>
      )}

      {setup.error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{setup.error}</span>
        </p>
      )}
    </div>
  );
});
