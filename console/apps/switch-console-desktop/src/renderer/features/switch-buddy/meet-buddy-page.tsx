import { BuddyStartCard } from '@switch-console/chat-ui/components/buddy-start-card';
import { MeetBuddyIntro } from '@switch-console/chat-ui/components/meet-buddy-intro';
import { Button } from '@switch-console/chat-ui/primitives/button';
import { TermInfo } from '@switch-console/chat-ui/primitives/term-info';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MachineConsentPrompt } from '@renderer/features/machines/turn-on-machine';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { OnboardingSurface, useWizardExit } from '@renderer/lib/ui/wizard-frame';
import { offeredAgentProviders } from '@shared/core/providers/agent-provider-registry';
import { BuddyAvatar } from './buddy-avatar';
import { findBuddy, firstNameOf } from './buddy-identity';
import { buddyPerson } from './buddy-person';
import { buddyProviders, startButtons } from './buddy-providers';
import { reportBuddyStep } from './buddy-telemetry';
import { ComputerNote } from './provider-cards';
import { ProviderSetup } from './provider-setup';
import { useStartBuddy } from './use-start-buddy';
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
 * A computer that does not run agents for the workspace yet says so here,
 * with the button that turns it on once the person confirms; until then the
 * providers Console found as onboarding opened are what the page goes by.
 * Picking one of those while it is off asks the same confirmation, and starts
 * the buddy with it once the computer is on.
 */
export const MeetBuddyPage = observer(function MeetBuddyPage({
  serverId,
  workspaceId,
  onCreated,
  onSkip,
  onSetupOpened,
}: {
  serverId: string;
  workspaceId: string;
  onCreated: (agent: { agentId: string; name: string }) => void;
  onSkip: () => void;
  /** The person opened the other providers' setup, for the page that holds this one to count. */
  onSetupOpened: () => void;
}) {
  const exit = useWizardExit();
  const [settingUp, setSettingUp] = useState(false);
  const thisComputer = useThisComputer(serverId, workspaceId);
  const { state: computer, earlyProviders } = thisComputer;
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
  const flags = useFeatureFlags(serverId);
  const providers = useMemo(
    () => buddyProviders(offeredAgentProviders(flags), reported),
    [reported, flags]
  );
  const [outOfPatience, setOutOfPatience] = useState(false);
  const machineReady = reported !== null;
  // Counted from when the page opens, not from the first report: a computer
  // that never reports must not leave a spinner with nothing to press.
  useEffect(() => {
    const timer = setTimeout(() => setOutOfPatience(true), CHECK_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, []);
  // The Start buttons appear once, together, and stay as they first were:
  // the row would change under the eye if each were added as its check came
  // back.
  const decided = machineReady || outOfPatience ? startButtons(providers, outOfPatience) : null;
  const [firstDecided, setFirstDecided] = useState<string[] | null>(null);
  useEffect(() => {
    if (decided && firstDecided === null) setFirstDecided(decided.map((provider) => provider.id));
  }, [decided, firstDecided]);
  const checked = firstDecided !== null;
  const ready = useMemo(
    () => (firstDecided ?? []).flatMap((id) => providers.filter((provider) => provider.id === id)),
    [firstDecided, providers]
  );
  const existing = findBuddy(useManagedAgents(serverId).data);
  const { starting, error, start } = useStartBuddy({
    serverId,
    workspaceId,
    computer,
    onCreated,
  });
  // A provider picked while this computer runs no managed agents: it waits
  // on the person turning the computer on, and is forgotten if they do not.
  const [pickedWhileOff, setPickedWhileOff] = useState<string | null>(null);
  const asking = computer.kind === 'off' ? pickedWhileOff : null;
  const pick = (providerId: string) => {
    if (computer.kind === 'off') setPickedWhileOff(providerId);
    else start(providerId);
  };
  const turnOnAndStart = (providerId: string) => {
    setPickedWhileOff(null);
    void thisComputer.turnOn();
    start(providerId);
  };
  const firstName = firstNameOf(buddyPerson(serverId).name);
  // The opening plays once: back from setting up a provider, it is at rest.
  const introPlayed = useRef(false);

  const skip = () => {
    reportBuddyStep('skip', null);
    onSkip();
  };

  const openSetup = () => {
    reportBuddyStep('setup_opened', null);
    onSetupOpened();
    setSettingUp(true);
  };

  const header = (
    <div className="flex flex-col items-center gap-2 text-center">
      <BuddyAvatar size={48} shape="tile" />
      <h1 className="mt-2 text-2xl font-semibold">Meet switch-buddy</h1>
    </div>
  );

  if (settingUp)
    return (
      <OnboardingSurface
        key="setup"
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
        <ProviderSetup
          serverId={serverId}
          workspaceId={workspaceId}
          onCreated={onCreated}
          thisComputer={thisComputer}
        />
      </OnboardingSurface>
    );

  return (
    <OnboardingSurface
      key="meet"
      exit={exit}
      // The opening scene stages its own entrance.
      enter={introPlayed.current}
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
        ) : null
      }
    >
      <MeetBuddyIntro
        firstName={firstName}
        here="Console"
        play={!introPlayed.current}
        onPlayed={() => {
          introPlayed.current = true;
        }}
        after={
          existing ? null : (
            <div className="flex flex-col gap-3">
              <StartChoices
                checking={computer.kind !== 'failed' && !checked}
                ready={ready}
                starting={starting}
                onStart={pick}
                onSetUp={openSetup}
                onSkip={skip}
              />
              {asking !== null && (
                <MachineConsentPrompt
                  serverId={serverId}
                  label="This computer"
                  sshHost={null}
                  confirmLabel="Turn on and start"
                  onCancel={() => setPickedWhileOff(null)}
                  onConfirm={() => turnOnAndStart(asking)}
                />
              )}
            </div>
          )
        }
      />
      {computer.kind === 'off' && asking === null && (
        <div className="flex justify-center">
          <ComputerNote
            serverId={serverId}
            computer={computer}
            onRetry={thisComputer.retry}
            onTurnOn={() => void thisComputer.turnOn()}
          />
        </div>
      )}
      {computer.kind === 'failed' && (
        <div className="flex flex-col items-center gap-2">
          <p role="alert" className="text-center text-sm text-destructive">
            {computer.error}
          </p>
          <Button variant="outline" size="sm" onClick={thisComputer.retry}>
            Try again
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-center text-sm text-destructive">
          {error}
        </p>
      )}
    </OnboardingSurface>
  );
});

/** How to start the buddy, as the chat's last turn (`BuddyStartCard`), with this computer's sign-ins. */
export function StartChoices(props: {
  checking: boolean;
  ready: { id: string; name: string }[];
  starting: string | null;
  onStart: (providerId: string) => void;
  onSetUp: () => void;
  onSkip: () => void;
}) {
  return (
    <BuddyStartCard
      {...props}
      icon={(id, size) => <AgentIcon id={id} size={size} />}
      readyTag="Signed in locally"
      info={<TermInfo term="provider" />}
    />
  );
}
