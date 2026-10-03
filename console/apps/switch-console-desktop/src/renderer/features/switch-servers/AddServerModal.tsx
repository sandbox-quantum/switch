import { CircleCheck, Cloud, Globe, Info, Laptop, Server, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { NewAgentForm } from '@renderer/features/locations/components/add-agent-modal/new-agent-form';
import { HostReachabilityNotice } from '@renderer/features/remote-hosts/host-reachability-notice';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { report } from '@renderer/lib/telemetry/report';
import { Alert, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { Spinner } from '@renderer/lib/ui/spinner';
import { WizardFrame } from '@renderer/lib/ui/wizard-frame';
import {
  lockHolderSentence,
  othersRecentlySeen,
} from '@shared/core/managed-switch-server/managed-switch-server';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type {
  AddServerChoiceName,
  AddServerStepName,
} from '@shared/core/switch-servers/add-server-steps';
import type {
  ServerApiUrlPropagation,
  SwitchServer,
} from '@shared/core/switch-servers/switch-servers';
import { ConnectionsStep } from './connections-step';
import { LinkAccountsStep } from './link-accounts-step';
import { localServerStore } from './local-server-store';
import { LogTail } from './log-tail';
import { ManagedProviderConnectionSequence } from './managed-provider-connection-step';
import { ManagedProvidersStep } from './managed-providers-step';
import { remoteServerStore } from './remote-server-store';
import { type RemoteSetupAction, remoteSetupAction } from './remote-setup-action';
import {
  machineUnavailableReason,
  type SignedIn,
  ServerSignInFields,
  useServerSignIn,
} from './server-sign-in';
import { affectedSentence } from './shared-consoles';
import { switchServersStore } from './switch-servers-store';
import { useSwitchCloud } from './use-switch-cloud';

/**
 * Turn a server-API-URL cascade into a user-facing toast: confirm how many
 * agents were re-pointed (and that running sessions need a restart), and flag
 * any that failed so the edit never looks cleanly done when it wasn't.
 */
function notifyPropagation(propagation: ServerApiUrlPropagation): void {
  if (!propagation.apiUrlChanged) return;
  const updated = propagation.agents.filter((a) => a.outcome === 'updated');
  const failed = propagation.agents.filter((a) => a.outcome === 'failed');

  if (failed.length > 0) {
    toast({
      title: `Couldn't update ${failed.length} agent config${failed.length === 1 ? '' : 's'}`,
      description: `${failed.map((a) => a.agentName).join(', ')}. ${updated.length} other${updated.length === 1 ? '' : 's'} updated. Check the agent's host is reachable and retry.`,
      variant: 'destructive',
    });
    return;
  }

  if (updated.length > 0) {
    toast({
      title: `Updated ${updated.length} agent config${updated.length === 1 ? '' : 's'}`,
      description:
        'Each agent now points at the new API URL. Restart any running sessions to pick it up.',
    });
  }
}

type Props = BaseModalProps<void> & {
  /** Prefill the gateway URL. */
  initialGatewayUrl?: string;
  /** Prefill the API (agent bridge) URL. */
  initialApiUrl?: string;
  /** Prefill the name. */
  initialName?: string;
  /** When set, the modal edits this existing server instead of adding one. */
  serverId?: string;
  /** Jump straight to a step, skipping the chooser. `external` is the
   * connect-by-URL form; `remoteHost` sets up a managed stack on an SSH host. */
  mode?: 'local' | 'remoteHost' | 'external';
};

type Step =
  | 'managedAgent'
  | 'managedGitHub'
  | 'managedClaude'
  | 'managedReady'
  | 'choose'
  | 'local'
  | 'remoteHost'
  | 'external'
  | 'signIn'
  | 'linkAccounts';

/**
 * This wizard's steps and the shared list of step names say the same thing.
 *
 * The list is what a drop-off is reported against and cannot import a component.
 * Asserted both ways, so adding a step without naming it there — or leaving a
 * name behind after removing one — fails to compile.
 */
const _stepsAreExhaustive: AddServerStepName extends Step ? true : never = true;
const _stepsAreComplete: Step extends AddServerStepName ? true : never = true;
void _stepsAreExhaustive;
void _stepsAreComplete;

/**
 * Add a Switch server: run one here, run one on a host you have onboarded, or
 * connect to one someone else runs.
 *
 * Only the third is a wizard. Connecting to an existing server is not finished
 * when the URL is saved — that server already has its own accounts and its own
 * messaging apps, and until you have signed in and said which account in each
 * app is you, the entry in the sidebar is a name with nothing behind it. So
 * those two steps follow in the same dialog rather than waiting on the server's
 * page to be discovered (CHOO-2164).
 */
/**
 * The path each step belongs to, or null for the steps that inherit whatever
 * was chosen before them.
 *
 * The chooser is `none` rather than null, and the difference is the whole point
 * of the column: arriving at the chooser is arriving with nothing chosen, which
 * is as true of pressing Back as it is of opening the wizard. Carrying the
 * abandoned path forwards would make a return read as progress along it.
 */
const CHOICE_FOR_STEP: Record<Step, AddServerChoiceName | null> = {
  choose: 'none',
  managedReady: 'cloud',
  managedClaude: 'cloud',
  managedGitHub: 'cloud',
  managedAgent: 'cloud',
  local: 'local',
  remoteHost: 'remoteHost',
  external: 'external',
  signIn: null,
  linkAccounts: null,
};

export const AddServerModal = observer(function AddServerModal(props: Props) {
  const isEdit = props.serverId != null;
  const openedAt: Step = isEdit ? 'external' : (props.mode ?? 'choose');
  const openedWith = CHOICE_FOR_STEP[openedAt] ?? 'none';
  const [step, setStep] = useState<Step>(openedAt);
  const [providerIndex, setProviderIndex] = useState(0);
  const [selectedProviders, setSelectedProviders] = useState<AgentProviderId[]>([]);
  // Which path was taken at the chooser, carried so every later step can be
  // attributed to it. `none` while still on the chooser, which is what makes a
  // drop-off before choosing distinguishable from one after.
  const [choice, setChoice] = useState<AddServerChoiceName>(openedWith);

  /**
   * Report the step the wizard opened on.
   *
   * The steps below are reported as they are reached, so without this the first
   * one — the one every later step is measured against — is the only one never
   * counted, and the funnel has no denominator. The ref rather than the
   * dependency list is what holds it to a single report: strict mode mounts
   * every effect twice, and a wizard that opens twice per opening would put the
   * denominator out by a factor of two in development builds.
   *
   * Editing is not one of the steps. It borrows the same form to change a
   * server that already exists, reaches no step after this one, and counting it
   * would put arrivals in the funnel that were never adding anything.
   */
  const reportedOpening = useRef(false);
  useEffect(() => {
    if (isEdit || reportedOpening.current) return;
    reportedOpening.current = true;
    report('add_server_step', { step: openedAt, choice: openedWith, first_run: false });
  }, [isEdit, openedAt, openedWith]);

  /**
   * Move to a step, and report reaching it.
   *
   * One function rather than nine `setStep` calls: the wizard's back buttons go
   * through the same state, so instrumenting each site would count returning to
   * the chooser as reaching it again and make the funnel read as if people
   * restarted rather than gave up.
   */
  const goToStep = (next: Step) => {
    const nextChoice = CHOICE_FOR_STEP[next] ?? choice;
    setChoice(nextChoice);
    setStep(next);
    report('add_server_step', { step: next, choice: nextChoice, first_run: false });
  };
  // The server the wizard just created, and the subject of every step after
  // it. Null in edit mode and on the two managed paths, which is what
  // distinguishes the standalone edit form from step 2 of the wizard.
  const [connected, setConnected] = useState<SwitchServer | null>(null);
  // Why the account just created has no cloud machine warming, carried into
  // the managed steps so it is not lost with the sign-in form.
  const [machineUnavailable, setMachineUnavailable] = useState<string | null>(null);
  const machineNotice = machineUnavailable && (
    <MachineUnavailableNotice reason={machineUnavailable} />
  );
  const { navigate } = useNavigate();

  /**
   * End the flow on the new server's own page.
   *
   * Adding a server is done in order to use it, and the dialog closing onto
   * whatever was behind it left no sign anything had happened. A path that
   * cannot name the server it made lands nowhere rather than guessing.
   */
  /**
   * Switch Cloud has no form: its address is the build's. So it goes straight
   * from the chooser to signing in, and that step's Back returns to the
   * chooser rather than to a connect-by-URL form it never passed through. An
   * account already signed in goes on to setting up its cloud agents.
   */
  const enterCloud = (server: SwitchServer) => {
    const next: Step = switchServersStore.isConnected(server.id) ? 'managedReady' : 'signIn';
    setConnected(server);
    setChoice('cloud');
    setStep(next);
    report('add_server_step', { step: next, choice: 'cloud', first_run: false });
  };

  const finish = (serverId: string | null) => {
    if (serverId) {
      void switchServersStore.setActive(serverId);
      navigate('server', { serverId });
    }
    props.onSuccess();
  };

  if (step === 'choose') {
    return (
      <ChooseStep
        onLocal={() => goToStep('local')}
        onRemoteHost={() => goToStep('remoteHost')}
        onExternal={() => goToStep('external')}
        onCloud={enterCloud}
        onClose={props.onClose}
      />
    );
  }
  if (step === 'local') {
    return (
      <LocalSetupStep
        onBack={isEdit ? undefined : () => goToStep('choose')}
        onDone={finish}
        onClose={props.onClose}
        // The dialog is closed, not left part-way: Cancel is the way out and it
        // has no server to name.
        onRegistered={null}
      />
    );
  }
  if (step === 'remoteHost') {
    return (
      <RemoteHostSetupStep
        onBack={() => goToStep('choose')}
        onDone={finish}
        onClose={props.onClose}
        onRegistered={null}
      />
    );
  }
  if (step === 'managedClaude' && connected) {
    return (
      <>
        {machineNotice}
        <ManagedProviderConnectionSequence
          serverId={connected.id}
          providers={selectedProviders}
          index={providerIndex}
          onIndexChange={setProviderIndex}
          onBack={() => goToStep('managedReady')}
          onDone={() => goToStep('managedGitHub')}
          doneStepName="GitHub"
        />
      </>
    );
  }
  if (step === 'managedAgent' && connected) {
    return (
      <>
        {machineNotice}
        <NewAgentForm
          entryPoint="onboarding"
          initialRunLocation="cloud"
          serverId={connected.id}
          onBack={() => goToStep('managedGitHub')}
          onClose={() => finish(connected.id)}
        />
      </>
    );
  }
  if (step === 'managedGitHub' && connected) {
    return (
      <>
        {machineNotice}
        <ConnectionsStep
          onContinue={() => goToStep('managedAgent')}
          serverId={connected.id}
          onBack={() => goToStep('managedClaude')}
          onSkip={() => finish(connected.id)}
        />
      </>
    );
  }
  if (step === 'managedReady' && connected) {
    return (
      <>
        {machineNotice}
        <ManagedProvidersStep
          selected={selectedProviders}
          onSelectionChange={setSelectedProviders}
          onContinue={() => {
            setProviderIndex(0);
            goToStep('managedClaude');
          }}
          onSkip={() => finish(connected.id)}
        />
      </>
    );
  }
  if (step === 'signIn' && connected) {
    return (
      <SignInStep
        server={connected}
        onBack={() => goToStep(choice === 'cloud' ? 'choose' : 'external')}
        onClose={props.onClose}
        onSignedIn={(signedIn) => {
          setMachineUnavailable(machineUnavailableReason(signedIn));
          goToStep(choice === 'cloud' ? 'managedReady' : 'linkAccounts');
        }}
      />
    );
  }
  if (step === 'linkAccounts' && connected) {
    return (
      <LinkAccountsStep
        serverId={connected.id}
        serverName={connected.name}
        onDone={() => finish(connected.id)}
      />
    );
  }
  return (
    <ExternalServerStep
      onSuccess={props.onSuccess}
      onClose={props.onClose}
      initialGatewayUrl={props.initialGatewayUrl ?? null}
      initialApiUrl={props.initialApiUrl ?? null}
      initialName={props.initialName ?? null}
      serverId={props.serverId ?? null}
      isEdit={isEdit}
      firstRun={false}
      existing={connected}
      onBack={isEdit ? null : () => goToStep('choose')}
      onConnected={(server) => {
        setConnected(server);
        goToStep('signIn');
      }}
    />
  );
});

// ---------------------------------------------------------------------------
// Step 1 — choose where the server lives
// ---------------------------------------------------------------------------

function ChooseStep({
  onLocal,
  onRemoteHost,
  onExternal,
  onCloud,
  onClose,
}: {
  onLocal: () => void;
  onRemoteHost: () => void;
  onExternal: () => void;
  onCloud: (server: SwitchServer) => void;
  onClose: () => void;
}) {
  const cloud = useSwitchCloud();
  const [cloudAttempt, setCloudAttempt] = useState<{ connecting: boolean; error: string | null }>({
    connecting: false,
    error: null,
  });
  const connectToCloud = () => {
    setCloudAttempt({ connecting: true, error: null });
    switchServersStore.connectToSwitchCloud().then(onCloud, (cause) => {
      const failure = describeFailure(cause, 'Could not connect to Switch Cloud.');
      setCloudAttempt({
        connecting: false,
        error: failure.detail ? `${failure.headline} ${failure.detail}` : failure.headline,
      });
    });
  };

  return (
    <WizardFrame
      title="Add a Switch server"
      subtitle={null}
      pager={{ pageName: 'Add a server', onBack: null, onNext: null }}
      footer={
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <div className="grid gap-3">
        {/* Offered only when this build knows where the Cloud is. A failed read
            is shown rather than dropped, since it means the build is broken. */}
        {cloud.kind === 'open' && (
          <ChoiceCard
            icon={
              cloudAttempt.connecting ? (
                <Spinner className="size-5" />
              ) : (
                <Cloud className="size-5" />
              )
            }
            title="Connect to Switch Cloud"
            description={`Sign in to the Switch we run for you at ${new URL(cloud.url).host}.`}
            onClick={connectToCloud}
            disabled={cloudAttempt.connecting}
          />
        )}
        {cloudAttempt.error && (
          <Alert variant="destructive">
            <TriangleAlert className="size-4" />
            <AlertTitle>Could not connect to Switch Cloud</AlertTitle>
            <AlertDescription>{cloudAttempt.error}</AlertDescription>
          </Alert>
        )}
        {cloud.kind === 'failed' && (
          <Alert variant="destructive">
            <TriangleAlert className="size-4" />
            <AlertTitle>{cloud.headline}</AlertTitle>
            {cloud.detail && <AlertDescription>{cloud.detail}</AlertDescription>}
          </Alert>
        )}
        <ChoiceCard
          icon={<Laptop className="size-5" />}
          title="Run a server on this computer"
          description="Switch Console sets up and runs the full Switch stack here with Docker. Best for trying Switch out."
          onClick={onLocal}
        />
        <ChoiceCard
          icon={<Server className="size-5" />}
          title="Run or join a server on a remote host"
          description="Switch Console sets one up over SSH on a host you've onboarded, or joins the one already running there. Stays running when Switch Console is closed."
          onClick={onRemoteHost}
        />
        <ChoiceCard
          icon={<Globe className="size-5" />}
          title="Connect to an existing server"
          description="Point Switch Console at a Switch gateway someone else runs, by URL."
          onClick={onExternal}
        />
      </div>
    </WizardFrame>
  );
}

export function ChoiceCard({
  icon,
  title,
  description,
  onClick,
  disabled = false,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  /** While the choice is already being acted on. */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="bg-card hover:border-border-hover flex items-start gap-3 rounded-lg border border-border p-4 text-left hover:bg-background-tertiary-2 disabled:pointer-events-none disabled:opacity-60"
    >
      <span className="mt-0.5 text-foreground-muted">{icon}</span>
      <span className="space-y-1">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="block text-xs text-foreground-muted">{description}</span>
      </span>
    </button>
  );
}

function SetupStepItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-foreground-muted" />
      <span>{children}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Step 2a — local server setup (preflight → progress → done)
// ---------------------------------------------------------------------------

export const LocalSetupStep = observer(function LocalSetupStep({
  onBack,
  onDone,
  onClose,
  onRegistered,
}: {
  onBack?: () => void;
  /** Reports the server the stack registered, so the flow can end on it. */
  onDone: (serverId: string | null) => void;
  /** Null where the flow has no way out but forwards — the first-run pages. */
  onClose: (() => void) | null;
  /**
   * Reports the server the moment it is registered rather than when Done is
   * pressed, so a flow that offers a way out can aim it at the right row.
   * Null for a chrome with no such offer — the dialog, which is closed instead
   * of left.
   */
  onRegistered: ((serverId: string) => void) | null;
}) {
  const store = localServerStore;

  useEffect(() => {
    void store.init();
    void store.checkDocker();
  }, [store]);

  const registeredId = store.status?.serverId ?? null;
  useEffect(() => {
    if (registeredId !== null) onRegistered?.(registeredId);
  }, [registeredId, onRegistered]);

  const running = store.isRunning;
  const starting = store.isTransitioning;
  const docker = store.docker;
  const dockerReady = docker?.available ?? false;
  const dockerUnavailable = docker && !docker.available ? docker : null;
  const idle = !running && !starting;

  // The pager's back arrow only ever repeats the footer's Back, so the two read
  // one const. Open during the install too: the store is a singleton the main
  // process streams into, so leaving loses only what is on screen, and holding
  // the page shut left the full-window flow with no live control at all through
  // a multi-gigabyte pull — while the same page in the dialog could still be
  // dismissed with Escape.
  const goBack = onBack ?? null;

  const primaryLabel = running ? 'Done' : store.phase === 'error' ? 'Retry' : 'Start';
  const onPrimary = () => {
    if (running) onDone(store.status?.serverId ?? null);
    else void store.start();
  };

  return (
    <WizardFrame
      title="Set up a server on this computer"
      subtitle="Switch Console installs the full stack with Docker and keeps it updated."
      pager={{ pageName: 'Set up a server', onBack: goBack, onNext: null }}
      footer={
        <>
          <BackOrClose
            onBack={goBack}
            onClose={onClose}
            closeDisabled={starting}
            closeLabel={running ? 'Close' : 'Cancel'}
          />
          <ConfirmButton onClick={onPrimary} disabled={starting || (!running && !dockerReady)}>
            {starting ? 'Starting…' : primaryLabel}
          </ConfirmButton>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-background-tertiary text-foreground-muted">
            <Laptop className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Switch server · this computer</p>
            <p className="truncate text-xs text-foreground-muted">
              switch-core {store.status?.version ?? ''} · runs on this computer via Docker
            </p>
          </div>
        </div>

        {idle && (
          <div className="bg-card space-y-2 rounded-lg border border-border p-3">
            <p className="text-xs font-medium text-foreground-muted">Starting will:</p>
            <ul className="space-y-1.5 text-xs text-foreground-muted">
              <SetupStepItem>
                Pull the Switch images from GHCR (first run downloads a few GB)
              </SetupStepItem>
              <SetupStepItem>Run Postgres, Matrix, Mattermost and Switch in Docker</SetupStepItem>
              <SetupStepItem>
                Register it as your active server, ready to onboard an agent
              </SetupStepItem>
            </ul>
          </div>
        )}

        {!running && (
          <DockerStatus ready={dockerReady} unavailable={dockerUnavailable} checking={!docker} />
        )}

        {running && (
          <Alert>
            <CircleCheck className="size-4" />
            <AlertTitle>Local server is running</AlertTitle>
            <AlertDescription>
              It's now in your servers list — open it to onboard an agent.
            </AlertDescription>
          </Alert>
        )}

        {store.error && !dockerUnavailable && !running && (
          <Alert variant="destructive">
            <AlertTitle>{store.error}</AlertTitle>
            {store.errorDetail && <AlertDescription>{store.errorDetail}</AlertDescription>}
          </Alert>
        )}

        {(starting || store.logs.length > 0) && !running && (
          <div className="space-y-1.5">
            {store.message && starting && (
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm text-foreground">
                  <Spinner className="size-3.5" />
                  <span>{store.message}</span>
                </div>
                {/* Said out loud, because Back being live during a download
                    that takes minutes otherwise looks like it cancels one. */}
                <p className="text-xs text-foreground-muted">
                  This keeps running if you leave the page — come back here to watch it.
                </p>
              </div>
            )}
            <LogTail
              lines={store.logs}
              placeholder={starting ? 'Waiting for Docker to report progress…' : null}
            />
          </div>
        )}
      </div>
    </WizardFrame>
  );
});

/**
 * The button on the left of a wizard's footer.
 *
 * A page that can be left offers Cancel; one that can only be stepped back
 * through offers Back; the first-run pages can do neither while a stack is
 * installing, and get a Back that is visibly held rather than no button and a
 * footer that changes shape under the eye.
 */
function BackOrClose({
  onBack,
  onClose,
  closeDisabled,
  closeLabel,
}: {
  onBack: (() => void) | null;
  onClose: (() => void) | null;
  closeDisabled: boolean;
  closeLabel: string;
}) {
  if (onBack) {
    return (
      <Button variant="outline" onClick={onBack}>
        Back
      </Button>
    );
  }
  if (onClose) {
    return (
      <Button variant="outline" onClick={onClose} disabled={closeDisabled}>
        {closeLabel}
      </Button>
    );
  }
  return (
    <Button variant="outline" disabled>
      Back
    </Button>
  );
}

function DockerStatus({
  ready,
  unavailable,
  checking,
}: {
  ready: boolean;
  unavailable: { reason: 'not-installed' | 'daemon-down'; detail: string } | null;
  checking: boolean;
}) {
  if (checking) {
    return (
      <div className="flex items-center gap-2 text-sm text-foreground-muted">
        <Spinner className="size-3.5" />
        <span>Checking Docker…</span>
      </div>
    );
  }
  if (unavailable) {
    return (
      <Alert variant="destructive">
        <TriangleAlert className="size-4" />
        <AlertTitle>
          {unavailable.reason === 'not-installed'
            ? 'Docker is not installed'
            : 'Docker is not running'}
        </AlertTitle>
        <AlertDescription>{unavailable.detail}</AlertDescription>
      </Alert>
    );
  }
  if (ready) {
    return (
      <div className="flex items-center gap-2 text-sm text-foreground">
        <CircleCheck className="size-4 text-green-500" />
        <span>Docker is ready.</span>
      </div>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step 2b — remote-host managed setup (pick an onboarded SSH host → start)
// ---------------------------------------------------------------------------

/** Exported for its test; the modal is its only other user. */
export const RemoteHostSetupStep = observer(function RemoteHostSetupStep({
  onBack,
  onDone,
  onClose,
  onRegistered,
}: {
  onBack: () => void;
  /** Reports the server the stack registered, so the flow can end on it. */
  onDone: (serverId: string | null) => void;
  onClose: () => void;
  /** As on the local page: the registration, not the Done press. */
  onRegistered: ((serverId: string) => void) | null;
}) {
  const store = remoteServerStore;
  const [hosts, setHosts] = useState<{ sshHost: string; name: string }[] | null>(null);
  const [sshHost, setSshHost] = useState<string | null>(null);
  const [name, setName] = useState('');

  useEffect(() => {
    void store.init();
    void rpc.remoteHosts.listHosts().then((list) => {
      setHosts(list);
      if (list.length === 1) {
        setSshHost(list[0]!.sshHost);
        setName(`${list[0]!.name} Switch server`);
      }
    });
  }, [store]);

  // What is offered depends on what the host already has, so look first, and
  // again when a host that was out of reach comes back.
  const hostBlocked = sshHost ? store.isHostBlocked(sshHost) : false;
  useEffect(() => {
    if (!sshHost || hostBlocked) return;
    void store.checkDocker(sshHost);
    void store.probe(sshHost);
  }, [store, sshHost, hostBlocked]);

  const running = sshHost ? store.isRunning(sshHost) : false;
  const starting = sshHost ? store.isTransitioning(sshHost) : false;
  const docker = sshHost ? store.dockerFor(sshHost) : null;
  const dockerReady = docker?.available ?? false;
  const dockerUnavailable = docker && !docker.available ? docker : null;
  const status = sshHost ? store.statusFor(sshHost) : null;
  const logs = sshHost ? store.logsFor(sshHost) : [];
  const probe = sshHost ? store.probeFor(sshHost) : null;
  const action = sshHost ? remoteSetupAction(sshHost, probe, store.isProbing(sshHost)) : null;
  // Another Console changing the server right now; Start or Connect will wait for it.
  const busy = probe?.kind === 'absent' || probe?.kind === 'present' ? probe.busy : null;
  const waiting = status?.waitingFor ?? null;
  const joining = action?.kind === 'connect';

  const registeredId = sshHost ? (status?.serverId ?? null) : null;
  useEffect(() => {
    if (registeredId !== null) onRegistered?.(registeredId);
  }, [registeredId, onRegistered]);

  const canAct =
    !!sshHost &&
    name.trim().length > 0 &&
    dockerReady &&
    !starting &&
    !hostBlocked &&
    (action?.kind === 'connect' || action?.kind === 'start');
  const updating = action?.kind === 'connect' && action.updatesTo !== null;
  // Joining an older server updates it for everyone using it, so name who that is.
  useEffect(() => {
    if (sshHost && updating) void store.loadRegister(sshHost);
  }, [store, sshHost, updating]);
  const affected =
    sshHost && updating
      ? affectedSentence(othersRecentlySeen(store.registerFor(sshHost), new Date()), new Date())
      : null;
  // One const for the footer's Back and the pager's back arrow, which only
  // repeats it. Open during the install, for the same reason as the local page:
  // the store outlives the page, so nothing is abandoned by leaving it.
  const goBack = onBack;
  const primaryLabel = running
    ? 'Done'
    : status?.phase === 'error'
      ? 'Retry'
      : joining
        ? updating
          ? 'Update and connect'
          : 'Connect'
        : 'Start';
  const onPrimary = () => {
    if (running) onDone(sshHost ? (store.statusFor(sshHost).serverId ?? null) : null);
    else if (sshHost && joining) void store.connect(sshHost, name.trim());
    else if (sshHost) void store.start(sshHost, name.trim());
  };

  return (
    <WizardFrame
      title="Run or join a server on a remote host"
      subtitle={null}
      pager={{
        pageName: 'Set up on a remote host',
        onBack: goBack,
        onNext: null,
      }}
      footer={
        <>
          {sshHost && starting && waiting ? (
            // Only a wait for another Console can be cancelled: nothing has
            // been changed yet.
            <Button variant="outline" onClick={() => void store.cancelWait(sshHost)}>
              Stop waiting
            </Button>
          ) : (
            <BackOrClose onBack={goBack} onClose={onClose} closeDisabled closeLabel="Cancel" />
          )}
          <ConfirmButton onClick={onPrimary} disabled={!running && !canAct}>
            {starting
              ? updating
                ? 'Updating…'
                : joining
                  ? 'Connecting…'
                  : 'Starting…'
              : primaryLabel}
          </ConfirmButton>
        </>
      }
    >
      <div className="space-y-4">
        {hosts === null ? (
          <div className="flex items-center gap-2 text-sm text-foreground-muted">
            <Spinner className="size-3.5" />
            <span>Loading onboarded hosts…</span>
          </div>
        ) : hosts.length === 0 ? (
          <Alert>
            <TriangleAlert className="size-4" />
            <AlertTitle>No onboarded hosts</AlertTitle>
            <AlertDescription>
              Onboard a remote host first (in Remote hosts settings), then come back to run a server
              on it.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <Field>
              <FieldLabel>Host</FieldLabel>
              <div className="grid gap-2">
                {hosts.map((h) => (
                  <button
                    key={h.sshHost}
                    type="button"
                    disabled={starting}
                    onClick={() => {
                      setSshHost(h.sshHost);
                      if (!name.trim()) setName(`${h.name} Switch server`);
                    }}
                    className={`flex items-center gap-2 rounded-md border p-2.5 text-left text-sm ${
                      sshHost === h.sshHost
                        ? 'border-primary bg-background-tertiary-2'
                        : 'border-border hover:bg-background-tertiary-2'
                    }`}
                  >
                    <Server className="size-4 shrink-0 text-foreground-muted" />
                    <span className="min-w-0">
                      <span className="block truncate text-foreground">{h.name}</span>
                      <span className="block truncate text-xs text-foreground-muted">
                        {h.sshHost}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </Field>

            {sshHost && <HostReachabilityNotice sshHost={sshHost} />}

            {sshHost && (
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Team Switch server"
                  disabled={starting}
                />
              </Field>
            )}

            {sshHost && action && !running && (
              <RemoteStackNotice
                sshHost={sshHost}
                action={action}
                affected={affected}
                onCheckAgain={() => void store.probe(sshHost)}
              />
            )}

            {sshHost && busy && !starting && !running && (
              <Alert>
                <Info className="size-4" />
                <AlertTitle>{lockHolderSentence(busy)}</AlertTitle>
              </Alert>
            )}

            {sshHost && action?.kind === 'start' && !action.existing && !running && (
              <div className="bg-card space-y-2 rounded-lg border border-border p-3">
                <p className="text-xs font-medium text-foreground-muted">Starting will:</p>
                <ul className="space-y-1.5 text-xs text-foreground-muted">
                  <SetupStepItem>
                    Pull the Switch images from GHCR on {sshHost} (first run downloads a few GB)
                  </SetupStepItem>
                  <SetupStepItem>
                    Run the stack in Docker on the host, bound to its loopback
                  </SetupStepItem>
                  <SetupStepItem>
                    Bridge it to this computer over SSH so local agents can reach it too
                  </SetupStepItem>
                </ul>
              </div>
            )}

            {sshHost && !running && (
              <DockerStatus
                ready={dockerReady}
                unavailable={dockerUnavailable}
                checking={!docker}
              />
            )}

            {running && (
              <Alert>
                <CircleCheck className="size-4" />
                <AlertTitle>Server is running on {sshHost}</AlertTitle>
                <AlertDescription>
                  It's in your servers list, reachable from this computer while Switch Console is
                  open. Anyone else with access to {sshHost} can connect to it from their own Switch
                  Console.
                </AlertDescription>
              </Alert>
            )}

            {store.error && !dockerUnavailable && !running && (
              <Alert variant="destructive">
                <AlertTitle>{store.error}</AlertTitle>
                {store.errorDetail && <AlertDescription>{store.errorDetail}</AlertDescription>}
              </Alert>
            )}

            {(starting || logs.length > 0) && !running && (
              <div className="space-y-1.5">
                {status?.message && starting && (
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <Spinner className="size-3.5" />
                    <span>{status.message}</span>
                  </div>
                )}
                <LogTail
                  lines={logs}
                  placeholder={starting ? 'Waiting for Docker to report progress…' : null}
                />
              </div>
            )}
          </>
        )}
      </div>
    </WizardFrame>
  );
});

/**
 * What the chosen host already has, and so what the primary button will do.
 * Renders nothing for an empty host.
 */
export function RemoteStackNotice({
  sshHost,
  action,
  affected,
  onCheckAgain,
}: {
  sshHost: string;
  action: RemoteSetupAction;
  /** Who else an update on joining reaches, when anyone does. */
  affected: string | null;
  onCheckAgain: () => void;
}) {
  switch (action.kind) {
    case 'checking':
      return (
        <div className="flex items-center gap-2 text-sm text-foreground-muted">
          <Spinner className="size-3.5" />
          <span>Looking for a Switch server on {sshHost}…</span>
        </div>
      );
    case 'connect':
      return (
        <Alert>
          <Info className="size-4" />
          <AlertTitle>
            A Switch server is already running on {sshHost}
            {action.deployedVersion ? ` (switch-core ${action.deployedVersion})` : ''}
          </AlertTitle>
          <AlertDescription>
            {action.updatesTo === null
              ? 'Connecting adds it to this Console without restarting it, so anyone already using it carries on undisturbed.'
              : `This Console needs switch-core ${action.updatesTo}, so connecting updates it — for everyone who uses it. Its database is backed up first, and it restarts once, keeping its rooms, agents and data.`}
            {action.updatesTo !== null && affected && ` ${affected}`}
            {!action.shared &&
              ' It was set up before servers could be shared; connecting shares it, so others with access to the host can connect too.'}
          </AlertDescription>
        </Alert>
      );
    case 'start':
      if (!action.existing) return null;
      return (
        <Alert>
          <Info className="size-4" />
          <AlertTitle>A Switch server is set up on {sshHost}, but stopped</AlertTitle>
          <AlertDescription>
            Starting it keeps its rooms, agents and data — and starts it for everyone who uses it.
          </AlertDescription>
        </Alert>
      );
    case 'blocked':
      return (
        <Alert variant="destructive">
          <TriangleAlert className="size-4" />
          <AlertTitle>{action.title}</AlertTitle>
          <AlertDescription>
            <span>{action.detail}</span>{' '}
            <button
              type="button"
              onClick={onCheckAgain}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Check again
            </button>
          </AlertDescription>
        </Alert>
      );
    case 'docker':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Step 2c — external server form (connect by URL; also the edit form)
// ---------------------------------------------------------------------------

function looksLikeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A name for a server the user was never asked to name.
 *
 * The first-run form leaves the field out — someone connecting their only
 * server has nothing to tell it apart from, and a required text box between
 * them and a working app is a question asked for the list's benefit rather than
 * theirs. The hostname is what they would have typed anyway, and renaming is a
 * click away once there is a sidebar to see it in.
 */
function nameFromGatewayUrl(gatewayUrl: string): string {
  // The host rather than the hostname: two servers on one machine differ only
  // by port, and a sidebar with two rows both called `localhost` names neither
  // of them. An IPv6 address keeps its brackets, which is how an address with
  // a port beside it is written.
  return new URL(gatewayUrl).host;
}

export const ExternalServerStep = observer(function ExternalServerStep({
  onSuccess,
  onClose,
  onBack,
  initialGatewayUrl,
  initialApiUrl,
  initialName,
  serverId,
  isEdit,
  firstRun,
  existing,
  onConnected,
}: {
  initialGatewayUrl: string | null;
  initialApiUrl: string | null;
  initialName: string | null;
  serverId: string | null;
  isEdit: boolean;
  /** The first-run wording of the same form: no name to ask for, and the
   * server's own accounts worth saying out loud before the sign-in step. */
  firstRun: boolean;
  onSuccess: () => void;
  onClose: () => void;
  onBack: (() => void) | null;
  /** Set when the wizard has already created the server and the user came back
   * to fix what they typed — the same form, saving instead of adding. */
  existing: SwitchServer | null;
  onConnected: (server: SwitchServer) => void;
}) {
  const [name, setName] = useState(initialName ?? existing?.name ?? '');
  const [gatewayUrl, setGatewayUrl] = useState(initialGatewayUrl ?? existing?.gatewayUrl ?? '');
  const [apiUrl, setApiUrl] = useState(initialApiUrl ?? existing?.apiUrl ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const trimmedGateway = gatewayUrl.trim();
  const trimmedApi = apiUrl.trim();
  const gatewayValid = looksLikeUrl(trimmedGateway);
  const apiValid = looksLikeUrl(trimmedApi);
  // In edit mode the name is owned by the separate Rename action, and on first
  // run it comes from the gateway, so neither shows the field or requires it.
  const asksForName = !isEdit && !firstRun;
  const isValid = (!asksForName || trimmedName.length > 0) && gatewayValid && apiValid;
  const submittedName = firstRun && gatewayValid ? nameFromGatewayUrl(trimmedGateway) : trimmedName;

  const gatewayMessage =
    trimmedGateway.length > 0 && !gatewayValid
      ? 'Enter a full URL, e.g. https://switch-gateway.example.com'
      : undefined;
  const apiMessage =
    trimmedApi.length > 0 && !apiValid
      ? 'Enter a full URL, e.g. https://switch-api.example.com'
      : undefined;

  // The row this form writes to, when one already exists: the server being
  // edited, or the one the wizard created before the user stepped back.
  const savedId = isEdit ? serverId : existing?.id;

  const handleSubmit = useCallback(async () => {
    if (!isValid) return;
    setSubmitting(true);
    setError(null);
    if (savedId) {
      const result = await switchServersStore.updateServer(
        savedId,
        submittedName,
        trimmedGateway,
        trimmedApi
      );
      if (!result) {
        setError(switchServersStore.errorText ?? 'Could not save the server.');
        setSubmitting(false);
        return;
      }
      notifyPropagation(result.propagation);
      if (!isEdit) {
        onConnected(result.server);
        return;
      }
    } else {
      const saved = await switchServersStore.addServer(submittedName, trimmedGateway, trimmedApi);
      if (!saved) {
        setError(switchServersStore.errorText ?? 'Could not add the server.');
        setSubmitting(false);
        return;
      }
      onConnected(saved);
      return;
    }
    onSuccess();
  }, [isValid, isEdit, savedId, submittedName, trimmedGateway, trimmedApi, onSuccess, onConnected]);

  // First run is asked before the saved row, because a page that goes on to the
  // sign-in must not offer "Save changes" — the user stepped back to fix an
  // address, and the button still takes them forward rather than closing.
  const submitLabel = submitting
    ? savedId
      ? 'Saving…'
      : 'Adding…'
    : firstRun
      ? 'Sign in to this server'
      : savedId
        ? 'Save changes'
        : 'Add server';

  // The footer's Back and the pager's back arrow are the same move, so they
  // read one const. Shut while the form is submitting: the write registers a
  // server, and stepping off it mid-way leaves one behind with no page on it.
  const goBack = onBack && !submitting ? onBack : null;

  return (
    <WizardFrame
      title={
        isEdit
          ? 'Edit connection'
          : firstRun
            ? 'Connect to your server'
            : 'Connect to an existing server'
      }
      subtitle={firstRun ? 'Whoever set it up can give you these addresses.' : null}
      /* Editing a connection is one dialog rather than a flow, and a pager on
         it would invent pages either side that do not exist. */
      pager={
        isEdit
          ? null
          : {
              pageName: 'Connect to a server',
              onBack: goBack,
              onNext: null,
            }
      }
      footer={
        <>
          <Button
            variant="outline"
            onClick={goBack ?? onClose}
            disabled={!!onBack && goBack === null}
          >
            {onBack ? 'Back' : 'Cancel'}
          </Button>
          <ConfirmButton onClick={() => void handleSubmit()} disabled={!isValid || submitting}>
            {submitLabel}
          </ConfirmButton>
        </>
      }
    >
      <FieldGroup>
        {asksForName && (
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Pilot"
              autoFocus
            />
          </Field>
        )}
        <Field>
          <FieldLabel>Gateway URL</FieldLabel>
          <Input
            value={gatewayUrl}
            onChange={(e) => setGatewayUrl(e.target.value)}
            placeholder="https://switch-gateway.example.com"
            autoFocus={isEdit || firstRun}
          />
          {firstRun && (
            <p className="mt-1 text-xs text-foreground-muted">Where the app and its chat live.</p>
          )}
          {gatewayMessage && <p className="mt-1 text-xs text-destructive">{gatewayMessage}</p>}
        </Field>
        <Field>
          <FieldLabel>API URL</FieldLabel>
          <Input
            value={apiUrl}
            onChange={(e) => setApiUrl(e.target.value)}
            placeholder="https://switch-api.example.com"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSubmit();
            }}
          />
          {firstRun && (
            <p className="mt-1 text-xs text-foreground-muted">
              Where agents connect. Often the same host on a different port — whoever set the server
              up knows which.
            </p>
          )}
          {apiMessage && <p className="mt-1 text-xs text-destructive">{apiMessage}</p>}
          {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
        </Field>
        {firstRun && (
          <Alert>
            <Info className="size-4" />
            <AlertDescription>
              This server keeps its own accounts. Signing in here signs you in to it, not to
              anything else.
            </AlertDescription>
          </Alert>
        )}
      </FieldGroup>
    </WizardFrame>
  );
});

// ---------------------------------------------------------------------------
// Step 3 — sign in to the server that was just added
// ---------------------------------------------------------------------------

/**
 * Signing in here rather than on the server's page, because everything the
 * next step and the sidebar want to show is behind the session: an added but
 * signed-out server lists no rooms, no agents and no messaging apps, and looks
 * broken rather than unauthenticated.
 */
export const SignInStep = observer(function SignInStep({
  server,
  onBack,
  onClose,
  onSignedIn,
}: {
  server: SwitchServer;
  onBack: () => void;
  /** Null where there is nothing to close onto — the first-run pages. */
  onClose: (() => void) | null;
  onSignedIn: (signedIn: SignedIn) => void;
}) {
  const signIn = useServerSignIn(server.id);
  const signingUp = signIn.mode === 'signUp';
  const canUsePassword = signingUp || (signIn.config?.passwordLoginEnabled ?? false);
  const canUseOidc = signIn.config?.oidcEnabled ?? false;

  const submit = async () => {
    const signedIn = await signIn.submitForm();
    if (signedIn) onSignedIn(signedIn);
  };

  // One const for the footer's Back and the pager's back arrow that repeats it.
  const goBack = signIn.submitting ? null : onBack;

  return (
    <WizardFrame
      title={signingUp ? `Create an account on ${server.name}` : `Sign in to ${server.name}`}
      subtitle={null}
      pager={{ pageName: 'Sign in', onBack: goBack, onNext: null }}
      footer={
        <>
          <Button variant="outline" onClick={onBack} disabled={goBack === null}>
            Back
          </Button>
          {canUsePassword ? (
            <ConfirmButton onClick={() => void submit()} disabled={!signIn.canSubmitForm}>
              {signIn.submitLabel}
            </ConfirmButton>
          ) : (
            // Nothing for a primary button to do: either the only method is the
            // provider button in the body, or the server offers none at all and
            // the body says so. Leaving a dead "Sign in" there would imply the
            // form was incomplete rather than absent.
            !canUseOidc &&
            onClose && (
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
            )
          )}
        </>
      }
    >
      {signIn.configCheckFailed && !signIn.configChecking && (
        <Button
          variant="outline"
          onClick={() => void switchServersStore.refreshAuthConfig(server.id)}
        >
          Retry sign-in options
        </Button>
      )}
      <ServerSignInFields
        signIn={signIn}
        idPrefix="connect-server-sign-in"
        gatewayUrl={server.gatewayUrl}
        onSignedIn={onSignedIn}
      />
    </WizardFrame>
  );
});

/** A just-created account whose cloud machine the server could not start. */
function MachineUnavailableNotice({ reason }: { reason: string }) {
  return (
    <div className="shrink-0 px-6 pt-6">
      <Alert>
        <TriangleAlert className="size-4" />
        <AlertTitle>Your cloud machine is not starting</AlertTitle>
        <AlertDescription>{reason}</AlertDescription>
      </Alert>
    </div>
  );
}
