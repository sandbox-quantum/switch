import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { onboardingStore } from '@renderer/features/onboarding/onboarding-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { report } from '@renderer/lib/telemetry/report';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { OnboardingSurface, useWizardExit } from '@renderer/lib/ui/wizard-frame';
import { agentProviders } from '@shared/core/providers/agent-provider-registry';
import { BuddyAvatar } from './buddy-avatar';
import { firstNameOf, isBuddy } from './buddy-identity';
import { BuddyIntroLines } from './buddy-intro-lines';
import { type BuddyProvider, buddyProviders } from './buddy-providers';
import { reportBuddyStep } from './buddy-telemetry';
import { createBuddy } from './create-buddy';
import { ProviderSetup } from './provider-setup';
import { useThisComputer } from './use-this-computer';

/** How many providers the page offers to start with outright; the rest are a click further. */
const START_BUTTONS = 2;

/**
 * How long the page waits for every provider's check before offering what is
 * ready anyway: a provider whose check never comes back must not hold the rest.
 */
const CHECK_PATIENCE_MS = 45_000;

/** The order the "Start with …" buttons go in: the most used first. */
const PREFERRED = ['claude', 'codex'];

function startOrder(providers: BuddyProvider[]): BuddyProvider[] {
  const rank = (id: string) => {
    const at = PREFERRED.indexOf(id);
    return at === -1 ? PREFERRED.length : at;
  };
  return [...providers].sort((a, b) => rank(a.id) - rank(b.id));
}

/**
 * Meet switch-buddy: who it is, in its own short lines, and the quickest way
 * to start it.
 *
 * A provider already installed and signed in on this computer is offered as
 * "Start with …" straight away, for the first two; the others, and providers
 * still to set up, are behind "Use another provider". It can be skipped, for
 * the chat to open without the buddy, asking for a provider there. Someone who
 * already has a buddy (replaying these pages) is offered to open it instead.
 *
 * This computer starts running agents for the workspace as the page opens, so
 * what its providers are ready for is known by the time it has been read.
 */
export const MeetBuddyPage = observer(function MeetBuddyPage({
  serverId,
  workspaceId,
  onCreated,
  onSkip,
}: {
  serverId: string;
  workspaceId: string;
  onCreated: (agent: { agentId: string; name: string }) => void;
  onSkip: () => void;
}) {
  const exit = useWizardExit();
  const [settingUp, setSettingUp] = useState(false);
  const { state: computer } = useThisComputer(serverId, workspaceId);
  const providers = useMemo(
    () => buddyProviders(agentProviders(), computer.kind === 'ready' ? computer.machine : null),
    [computer]
  );
  const [outOfPatience, setOutOfPatience] = useState(false);
  const machineReady = computer.kind === 'ready';
  useEffect(() => {
    if (!machineReady) return;
    const timer = setTimeout(() => setOutOfPatience(true), CHECK_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [machineReady]);
  // The Start buttons appear once, with every check back, rather than one at
  // a time as each returns: the row would change under the eye, and whichever
  // answered first would hold the main button until the preferred one came.
  const checked =
    machineReady && (outOfPatience || providers.every((provider) => provider.state !== 'checking'));
  const ready = useMemo(
    () =>
      checked
        ? startOrder(providers.filter((provider) => provider.state === 'ready')).slice(
            0,
            START_BUTTONS
          )
        : [],
    [checked, providers]
  );
  const existing = useManagedAgents(serverId).data?.find(isBuddy) ?? null;
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const user = switchServersStore.statusFor(serverId)?.user ?? null;
  const firstName = firstNameOf(user?.name);

  const skip = () => {
    reportBuddyStep('skip', null);
    onSkip();
  };

  const openSetup = () => {
    reportBuddyStep('setup_opened', null);
    report('onboarding_page', { page: 'provider_setup', path: onboardingStore.via });
    setSettingUp(true);
  };

  const startWith = async (providerId: string) => {
    if (computer.kind !== 'ready') return;
    setStarting(providerId);
    reportBuddyStep('start', providerId);
    setError(null);
    try {
      onCreated(
        await createBuddy({
          serverId,
          workspaceId,
          machineId: computer.machine.id,
          provider: providerId,
          person: { name: user?.name ?? null, email: user?.email ?? null },
        })
      );
    } catch (cause) {
      setError(failureText(cause, 'Could not create switch-buddy.'));
      setStarting(null);
    }
  };

  const header = (
    <div className="flex flex-col items-center gap-2 text-center">
      <BuddyAvatar size={settingUp ? 48 : 80} shape="tile" />
      <h1 className="mt-2 text-2xl font-semibold">Meet switch-buddy</h1>
      {!settingUp && (
        <p className="text-sm text-foreground-muted">Your first AI assistant in Switch</p>
      )}
    </div>
  );

  if (settingUp)
    return (
      <OnboardingSurface
        exit={exit}
        footer={
          <>
            <Button variant="outline" onClick={() => setSettingUp(false)}>
              Back
            </Button>
            <Button variant="ghost" onClick={skip}>
              Skip for now
            </Button>
          </>
        }
      >
        {header}
        <ProviderSetup serverId={serverId} workspaceId={workspaceId} onCreated={onCreated} />
      </OnboardingSurface>
    );

  const busy = starting !== null;
  return (
    <OnboardingSurface
      exit={exit}
      footer={
        existing ? (
          <Button
            onClick={() => {
              reportBuddyStep('opened_existing', null);
              onCreated(existing);
            }}
          >
            Open switch-buddy
          </Button>
        ) : (
          <div className="relative flex gap-2">
            <Button variant="outline" onClick={skip} disabled={busy}>
              Skip
            </Button>
            {ready.map((provider, index) => (
              <Button
                key={provider.id}
                variant={index === 0 ? 'default' : 'outline'}
                onClick={() => void startWith(provider.id)}
                disabled={busy}
              >
                {starting === provider.id && <Spinner className="size-3.5" />}
                Start with {provider.name}
              </Button>
            ))}
            <Button
              variant={ready.length === 0 ? 'default' : 'outline'}
              onClick={openSetup}
              disabled={busy}
            >
              {ready.length === 0 ? 'Set up AI provider' : 'Use another provider'}
            </Button>
            {/* Beside the buttons, not between them: the row stays where it is
                while this computer is still being checked. */}
            {computer.kind !== 'failed' && !checked && (
              <span className="absolute top-1/2 left-full ml-3 flex -translate-y-1/2 items-center gap-1.5 text-xs whitespace-nowrap text-foreground-muted">
                <Spinner className="size-3" />
                Checking AI providers…
              </span>
            )}
          </div>
        )
      }
    >
      {header}
      <BuddyIntroLines firstName={firstName} />
      {computer.kind === 'failed' && (
        <p role="alert" className="text-center text-sm text-destructive">
          {computer.error}
        </p>
      )}
      {error && (
        <p role="alert" className="text-center text-sm text-destructive">
          {error}
        </p>
      )}
    </OnboardingSurface>
  );
});
