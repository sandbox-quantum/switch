import { CircleCheck, Globe, Laptop, Server, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState } from 'react';
import { HostReachabilityNotice } from '@renderer/features/remote-hosts/host-reachability-notice';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { report } from '@renderer/lib/telemetry/report';
import { Alert, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { Spinner } from '@renderer/lib/ui/spinner';
import { WizardStepHeader } from '@renderer/lib/ui/wizard-step-header';
import type {
  AddServerChoiceName,
  AddServerStepName,
} from '@shared/core/switch-servers/add-server-steps';
import type {
  ServerApiUrlPropagation,
  SwitchServer,
} from '@shared/core/switch-servers/switch-servers';
import { LinkAccountsStep } from './link-accounts-step';
import { localServerStore } from './local-server-store';
import { LogTail } from './log-tail';
import { remoteServerStore } from './remote-server-store';
import { ServerSignInFields, useServerSignIn } from './server-sign-in';
import { switchServersStore } from './switch-servers-store';

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

type Step = 'choose' | 'local' | 'remoteHost' | 'external' | 'signIn' | 'linkAccounts';

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
 * How many steps connecting to a server someone else runs takes: choose that
 * path, point at the server, sign in, then say which messaging account is you.
 *
 * The chooser is step 1 but carries no counter — the other two paths it leads
 * to are not four steps, and a count shown before the choice would promise a
 * length that depends on what is clicked next.
 */
const CONNECT_STEPS = 4;

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
 * The path each step belongs to. `none` for the chooser and for steps that
 * inherit whatever was chosen before them.
 */
const CHOICE_FOR_STEP: Record<Step, AddServerChoiceName> = {
  choose: 'none',
  local: 'local',
  remoteHost: 'remoteHost',
  external: 'external',
  signIn: 'none',
  linkAccounts: 'none',
};

export const AddServerModal = observer(function AddServerModal(props: Props) {
  const isEdit = props.serverId != null;
  const [step, setStep] = useState<Step>(isEdit ? 'external' : (props.mode ?? 'choose'));
  // Which path was taken at the chooser, carried so every later step can be
  // attributed to it. `none` while still on the chooser, which is what makes a
  // drop-off before choosing distinguishable from one after.
  const [choice, setChoice] = useState<AddServerChoiceName>(
    isEdit ? 'external' : CHOICE_FOR_STEP[props.mode ?? 'choose']
  );

  /**
   * Move to a step, and report reaching it.
   *
   * One function rather than nine `setStep` calls: the wizard's back buttons go
   * through the same state, so instrumenting each site would count returning to
   * the chooser as reaching it again and make the funnel read as if people
   * restarted rather than gave up.
   */
  const goToStep = (next: Step) => {
    const nextChoice = CHOICE_FOR_STEP[next] === 'none' ? choice : CHOICE_FOR_STEP[next];
    setChoice(nextChoice);
    setStep(next);
    report('add_server_step', { step: next, choice: nextChoice });
  };
  // The server the wizard just created, and the subject of every step after
  // it. Null in edit mode and on the two managed paths, which is what
  // distinguishes the standalone edit form from step 2 of the wizard.
  const [connected, setConnected] = useState<SwitchServer | null>(null);
  const { navigate } = useNavigate();

  /**
   * End the flow on the new server's own page.
   *
   * Adding a server is done in order to use it, and the dialog closing onto
   * whatever was behind it left no sign anything had happened. A path that
   * cannot name the server it made lands nowhere rather than guessing.
   */
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
      />
    );
  }
  if (step === 'remoteHost') {
    return (
      <RemoteHostSetupStep
        onBack={() => goToStep('choose')}
        onDone={finish}
        onClose={props.onClose}
      />
    );
  }
  if (step === 'signIn' && connected) {
    return (
      <SignInStep
        server={connected}
        onBack={() => goToStep('external')}
        onClose={props.onClose}
        onSignedIn={() => goToStep('linkAccounts')}
      />
    );
  }
  if (step === 'linkAccounts' && connected) {
    return (
      <LinkAccountsStep
        serverId={connected.id}
        serverName={connected.name}
        step={CONNECT_STEPS}
        of={CONNECT_STEPS}
        onDone={() => finish(connected.id)}
      />
    );
  }
  return (
    <ExternalServerStep
      {...props}
      isEdit={isEdit}
      existing={connected}
      onBack={isEdit ? undefined : () => goToStep('choose')}
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
  onClose,
}: {
  onLocal: () => void;
  onRemoteHost: () => void;
  onExternal: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Add a Switch server</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <div className="grid gap-3">
          <ChoiceCard
            icon={<Laptop className="size-5" />}
            title="Run a server on this computer"
            description="Switch Console sets up and runs the full Switch stack here with Docker. Best for trying Switch out."
            onClick={onLocal}
          />
          <ChoiceCard
            icon={<Server className="size-5" />}
            title="Run a server on a remote host"
            description="Switch Console sets it up over SSH on a host you've onboarded. Stays running when Switch Console is closed."
            onClick={onRemoteHost}
          />
          <ChoiceCard
            icon={<Globe className="size-5" />}
            title="Connect to an existing server"
            description="Point Switch Console at a Switch gateway someone else runs, by URL."
            onClick={onExternal}
          />
        </div>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </DialogFooter>
    </>
  );
}

function ChoiceCard({
  icon,
  title,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="bg-card hover:border-border-hover flex items-start gap-3 rounded-lg border border-border p-4 text-left hover:bg-background-tertiary-2"
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

const LocalSetupStep = observer(function LocalSetupStep({
  onBack,
  onDone,
  onClose,
}: {
  onBack?: () => void;
  /** Reports the server the stack registered, so the flow can end on it. */
  onDone: (serverId: string | null) => void;
  onClose: () => void;
}) {
  const store = localServerStore;

  useEffect(() => {
    void store.init();
    void store.checkDocker();
  }, [store]);

  const running = store.isRunning;
  const starting = store.isTransitioning;
  const docker = store.docker;
  const dockerReady = docker?.available ?? false;
  const dockerUnavailable = docker && !docker.available ? docker : null;
  const idle = !running && !starting;

  const primaryLabel = running ? 'Done' : store.phase === 'error' ? 'Retry' : 'Start';
  const onPrimary = () => {
    if (running) onDone(store.status?.serverId ?? null);
    else void store.start();
  };

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Set up a server on this computer</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
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
              <div className="flex items-center gap-2 text-sm text-foreground">
                <Spinner className="size-3.5" />
                <span>{store.message}</span>
              </div>
            )}
            <LogTail
              lines={store.logs}
              placeholder={starting ? 'Waiting for Docker to report progress…' : null}
            />
          </div>
        )}
      </DialogContentArea>
      <DialogFooter>
        {onBack && !starting ? (
          <Button variant="outline" onClick={onBack}>
            Back
          </Button>
        ) : (
          <Button variant="outline" onClick={onClose} disabled={starting}>
            {running ? 'Close' : 'Cancel'}
          </Button>
        )}
        <ConfirmButton onClick={onPrimary} disabled={starting || (!running && !dockerReady)}>
          {starting ? 'Starting…' : primaryLabel}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});

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

const RemoteHostSetupStep = observer(function RemoteHostSetupStep({
  onBack,
  onDone,
  onClose,
}: {
  onBack: () => void;
  /** Reports the server the stack registered, so the flow can end on it. */
  onDone: (serverId: string | null) => void;
  onClose: () => void;
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

  useEffect(() => {
    if (sshHost) void store.checkDocker(sshHost);
  }, [store, sshHost]);

  const running = sshHost ? store.isRunning(sshHost) : false;
  const starting = sshHost ? store.isTransitioning(sshHost) : false;
  const docker = sshHost ? store.dockerFor(sshHost) : null;
  const dockerReady = docker?.available ?? false;
  const dockerUnavailable = docker && !docker.available ? docker : null;
  const status = sshHost ? store.statusFor(sshHost) : null;
  const logs = sshHost ? store.logsFor(sshHost) : [];

  const hostBlocked = sshHost ? store.isHostBlocked(sshHost) : false;
  const canStart = !!sshHost && name.trim().length > 0 && dockerReady && !starting && !hostBlocked;
  const primaryLabel = running ? 'Done' : status?.phase === 'error' ? 'Retry' : 'Start';
  const onPrimary = () => {
    if (running) onDone(sshHost ? (store.statusFor(sshHost).serverId ?? null) : null);
    else if (sshHost) void store.start(sshHost, name.trim());
  };

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Set up a server on a remote host</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
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

            {sshHost && !running && (
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
                  open.
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
      </DialogContentArea>
      <DialogFooter>
        {!starting ? (
          <Button variant="outline" onClick={onBack}>
            Back
          </Button>
        ) : (
          <Button variant="outline" onClick={onClose} disabled>
            Cancel
          </Button>
        )}
        <ConfirmButton onClick={onPrimary} disabled={!running && !canStart}>
          {starting ? 'Starting…' : primaryLabel}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});

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

const ExternalServerStep = observer(function ExternalServerStep({
  onSuccess,
  onClose,
  onBack,
  initialGatewayUrl,
  initialApiUrl,
  initialName,
  serverId,
  isEdit,
  existing,
  onConnected,
}: Props & {
  isEdit: boolean;
  onBack?: () => void;
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
  // In edit mode the name is owned by the separate Rename action, so this form
  // only edits the URLs — the name field isn't shown and isn't required.
  const isValid = (isEdit || trimmedName.length > 0) && gatewayValid && apiValid;

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
        trimmedName,
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
      const saved = await switchServersStore.addServer(trimmedName, trimmedGateway, trimmedApi);
      if (!saved) {
        setError(switchServersStore.errorText ?? 'Could not add the server.');
        setSubmitting(false);
        return;
      }
      onConnected(saved);
      return;
    }
    onSuccess();
  }, [isValid, isEdit, savedId, trimmedName, trimmedGateway, trimmedApi, onSuccess, onConnected]);

  return (
    <>
      {isEdit ? (
        <DialogHeader showCloseButton={false}>
          <DialogTitle>Edit connection</DialogTitle>
        </DialogHeader>
      ) : (
        <WizardStepHeader title="Connect to an existing server" step={2} of={CONNECT_STEPS} />
      )}
      <DialogContentArea className="pt-0">
        <FieldGroup>
          {!isEdit && (
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
              autoFocus={isEdit}
            />
            {gatewayMessage && <p className="text-destructive mt-1 text-xs">{gatewayMessage}</p>}
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
            {apiMessage && <p className="text-destructive mt-1 text-xs">{apiMessage}</p>}
            {error && <p className="text-destructive mt-1 text-xs">{error}</p>}
          </Field>
        </FieldGroup>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onBack ?? onClose}>
          {onBack ? 'Back' : 'Cancel'}
        </Button>
        <ConfirmButton onClick={() => void handleSubmit()} disabled={!isValid || submitting}>
          {submitting ? (savedId ? 'Saving…' : 'Adding…') : savedId ? 'Save changes' : 'Add server'}
        </ConfirmButton>
      </DialogFooter>
    </>
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
const SignInStep = observer(function SignInStep({
  server,
  onBack,
  onClose,
  onSignedIn,
}: {
  server: SwitchServer;
  onBack: () => void;
  onClose: () => void;
  onSignedIn: () => void;
}) {
  const signIn = useServerSignIn(server.id);
  const canUsePassword = signIn.config?.passwordLoginEnabled ?? false;
  const canUseOidc = signIn.config?.oidcEnabled ?? false;

  const submit = async () => {
    if (await signIn.signInWithPassword()) onSignedIn();
  };

  return (
    <>
      <WizardStepHeader title={`Sign in to ${server.name}`} step={3} of={CONNECT_STEPS} />
      <DialogContentArea className="pt-0">
        <ServerSignInFields
          signIn={signIn}
          idPrefix="connect-server-sign-in"
          gatewayUrl={server.gatewayUrl}
          onSignedIn={onSignedIn}
        />
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onBack} disabled={signIn.submitting}>
          Back
        </Button>
        {canUsePassword ? (
          <ConfirmButton
            onClick={() => void submit()}
            disabled={!signIn.canSubmitPassword || signIn.submitting}
          >
            {signIn.submitting ? 'Signing in…' : 'Sign in'}
          </ConfirmButton>
        ) : (
          // Nothing for a primary button to do: either the only method is the
          // provider button in the body, or the server offers none at all and
          // the body says so. Leaving a dead "Sign in" there would imply the
          // form was incomplete rather than absent.
          !canUseOidc && (
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          )
        )}
      </DialogFooter>
    </>
  );
});
