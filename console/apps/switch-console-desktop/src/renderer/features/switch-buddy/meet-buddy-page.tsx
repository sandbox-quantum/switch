import { observer } from 'mobx-react-lite';
import { motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { onboardingStore } from '@renderer/features/onboarding/onboarding-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { report } from '@renderer/lib/telemetry/report';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { OnboardingSurface, useWizardExit } from '@renderer/lib/ui/wizard-frame';
import { agentProviders } from '@shared/core/providers/agent-provider-registry';
import { BuddyAvatar } from './buddy-avatar';
import { firstNameOf, isBuddy } from './buddy-identity';
import { buddyProviders, startButtons } from './buddy-providers';
import { reportBuddyStep } from './buddy-telemetry';
import { createBuddy } from './create-buddy';
import { MeetBuddyIntro } from './meet-buddy-intro';
import { ProviderSetup } from './provider-setup';
import { useThisComputer } from './use-this-computer';

/**
 * How long the page waits for the provider checks before offering what is
 * ready anyway: a provider whose check never comes back must not hold the rest.
 */
const CHECK_PATIENCE_MS = 45_000;

/**
 * Meet switch-buddy: who it is, in its own short lines, and the quickest way
 * to start it.
 *
 * A provider already installed and signed in on this computer is offered
 * straight away, for the first two; the others, and providers still to set
 * up, are behind "Use other AI providers". With none signed in it can be
 * skipped, for the chat to open without the buddy, asking for a provider
 * there. Someone who already has a buddy (replaying these pages) is offered
 * to open it instead.
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
  const { state: computer, earlyProviders } = useThisComputer(serverId, workspaceId);
  // What this computer's controller reports, or until it does, what Console
  // found checking the providers as onboarding opened.
  const reported = useMemo(
    () =>
      computer.kind === 'ready'
        ? computer.machine
        : earlyProviders
          ? { providers: earlyProviders }
          : null,
    [computer, earlyProviders]
  );
  const providers = useMemo(() => buddyProviders(agentProviders(), reported), [reported]);
  const [outOfPatience, setOutOfPatience] = useState(false);
  const machineReady = reported !== null;
  useEffect(() => {
    if (!machineReady) return;
    const timer = setTimeout(() => setOutOfPatience(true), CHECK_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [machineReady]);
  // The Start buttons appear once, together, and stay as they first were:
  // the row would change under the eye if each were added as its check came
  // back.
  const decided = machineReady ? startButtons(providers, outOfPatience) : null;
  const [firstDecided, setFirstDecided] = useState<string[] | null>(null);
  useEffect(() => {
    if (decided && firstDecided === null) setFirstDecided(decided.map((provider) => provider.id));
  }, [decided, firstDecided]);
  const checked = firstDecided !== null;
  const ready = useMemo(
    () => (firstDecided ?? []).flatMap((id) => providers.filter((provider) => provider.id === id)),
    [firstDecided, providers]
  );
  const existing = useManagedAgents(serverId).data?.find(isBuddy) ?? null;
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const user = switchServersStore.statusFor(serverId)?.user ?? null;
  const firstName = firstNameOf(user?.name);
  // The opening plays once: back from setting up a provider, it is at rest.
  const introPlayed = useRef(false);

  const skip = () => {
    reportBuddyStep('skip', null);
    onSkip();
  };

  const openSetup = () => {
    reportBuddyStep('setup_opened', null);
    report('onboarding_page', { page: 'provider_setup', path: onboardingStore.via });
    setSettingUp(true);
  };

  // A provider chosen before this computer's controller is up: started once it is.
  const [waitingToStart, setWaitingToStart] = useState<string | null>(null);
  useEffect(() => {
    if (waitingToStart === null) return;
    if (computer.kind === 'failed') {
      setWaitingToStart(null);
      setStarting(null);
      return;
    }
    if (computer.kind !== 'ready') return;
    const providerId = waitingToStart;
    setWaitingToStart(null);
    void startWithRef.current(providerId);
  }, [computer, waitingToStart]);

  const startWith = async (providerId: string) => {
    setStarting(providerId);
    if (computer.kind !== 'ready') {
      setWaitingToStart(providerId);
      return;
    }
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
  const startWithRef = useRef(startWith);
  startWithRef.current = startWith;

  const header = (
    <div className="flex flex-col items-center gap-2 text-center">
      <BuddyAvatar size={48} shape="tile" />
      <h1 className="mt-2 text-2xl font-semibold">Meet switch-buddy</h1>
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
          <StartChoices
            checking={computer.kind !== 'failed' && !checked}
            ready={ready}
            starting={starting}
            onStart={(providerId) => void startWith(providerId)}
            onSetUp={openSetup}
            onSkip={skip}
          />
        )
      }
    >
      <MeetBuddyIntro
        firstName={firstName}
        play={!introPlayed.current}
        onPlayed={() => {
          introPlayed.current = true;
        }}
      />
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

/**
 * How to start the buddy, once this computer's providers are known. With a
 * provider already signed in, those are the way, beside another provider; no
 * Skip, though the flow's own way out stays at the top. With none, set one up
 * or skip.
 */
export function StartChoices({
  checking,
  ready,
  starting,
  onStart,
  onSetUp,
  onSkip,
}: {
  checking: boolean;
  ready: { id: string; name: string }[];
  starting: string | null;
  onStart: (providerId: string) => void;
  onSetUp: () => void;
  onSkip: () => void;
}) {
  const busy = starting !== null;
  const shown = checking ? 'checking' : ready.length > 0 ? 'signed-in' : 'none';
  return (
    <motion.div
      key={shown}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 26 }}
      className="flex flex-col items-center gap-3"
    >
      {shown === 'checking' ? (
        <span className="flex h-9 items-center gap-1.5 text-xs text-foreground-muted">
          <Spinner className="size-3" />
          Checking AI providers…
        </span>
      ) : shown === 'signed-in' ? (
        <>
          <p className="text-sm text-foreground-muted">How’d you like to power switch-buddy?</p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <span className="text-sm text-foreground-muted">Already signed in:</span>
            {ready.map((provider) => (
              <Button
                key={provider.id}
                variant="outline"
                onClick={() => onStart(provider.id)}
                disabled={busy}
              >
                {starting === provider.id ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <AgentIcon id={provider.id} size={16} />
                )}
                {provider.name}
              </Button>
            ))}
            <span className="text-sm text-foreground-muted">or</span>
            <Button variant="outline" onClick={onSetUp} disabled={busy}>
              Use other AI providers
            </Button>
          </div>
        </>
      ) : (
        <div className="flex gap-2">
          <Button variant="outline" onClick={onSkip}>
            Skip
          </Button>
          <Button onClick={onSetUp}>Set up AI provider</Button>
        </div>
      )}
    </motion.div>
  );
}
