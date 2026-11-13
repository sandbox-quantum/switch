import { CircleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { motion, useReducedMotion } from 'motion/react';
import { ComputerNote, ProviderCard, SelectedPanel } from './provider-cards';
import { useProviderSetup } from './use-provider-setup';
import type { ThisComputer } from './use-this-computer';

/**
 * Pick the AI provider switch-buddy runs on, get it ready on this computer,
 * and create the buddy with it (see `useProviderSetup`).
 *
 * `thisComputer` is the page's own `useThisComputer`, so a page that already
 * follows this computer does not set it up a second time.
 */
export const ProviderSetup = observer(function ProviderSetup({
  serverId,
  workspaceId,
  onCreated,
  thisComputer,
}: {
  serverId: string;
  workspaceId: string;
  onCreated: (agent: { agentId: string; name: string }) => void;
  thisComputer: {
    state: ThisComputer;
    recheck: () => Promise<string | null>;
    retry: () => void;
  };
}) {
  const computer = thisComputer.state;
  const reduced = useReducedMotion() ?? false;
  const setup = useProviderSetup({
    serverId,
    workspaceId,
    onCreated,
    computer,
    recheck: thisComputer.recheck,
  });

  return (
    <div className="flex flex-col gap-4">
      <ComputerNote computer={computer} onRetry={thisComputer.retry} />
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

      {/* What the selected provider needs next stays in view, pinned to the
          bottom of the page just above Back and Skip: below a long grid it
          would be off-screen, and a click on a card would seem to do nothing.
          It slides in as a provider is picked, so the eye follows it. */}
      {setup.selected && computer.kind === 'ready' && (
        <motion.div
          key={setup.selected.id}
          data-slot="provider-action"
          initial={reduced ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          className="sticky bottom-0 z-10 flex flex-col gap-3 rounded-xl border border-border bg-background p-4 shadow-lg"
        >
          <SelectedPanel
            provider={setup.selected}
            login={setup.login?.providerId === setup.selected.id ? setup.login : null}
            busy={setup.busy}
            onStart={() => setup.start(setup.selected!)}
            onSignIn={() => void setup.signIn(setup.selected!)}
            onCancelSignIn={setup.cancelSignIn}
            checked={setup.checked}
            onInstall={() => void setup.install(setup.selected!)}
            installFailed={setup.installFailed === setup.selected.id}
            onCheckAgain={() => void setup.checkAgain()}
          />
          {setup.error && <SetupError message={setup.error} />}
        </motion.div>
      )}

      {setup.error && !(setup.selected && computer.kind === 'ready') && (
        <SetupError message={setup.error} />
      )}
    </div>
  );
});

function SetupError({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span>{message}</span>
    </p>
  );
}
