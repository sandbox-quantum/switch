import { CircleCheck, Globe, HardDrive, Server, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
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
import type { ServerApiUrlPropagation } from '@shared/core/switch-servers/switch-servers';
import { localServerStore } from './local-server-store';
import { remoteServerStore } from './remote-server-store';
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

type Step = 'choose' | 'local' | 'remoteHost' | 'external';

export const AddServerModal = observer(function AddServerModal(props: Props) {
  const isEdit = props.serverId != null;
  const [step, setStep] = useState<Step>(isEdit ? 'external' : (props.mode ?? 'choose'));

  if (step === 'choose') {
    return (
      <ChooseStep
        onLocal={() => setStep('local')}
        onRemoteHost={() => setStep('remoteHost')}
        onExternal={() => setStep('external')}
        onClose={props.onClose}
      />
    );
  }
  if (step === 'local') {
    return (
      <LocalSetupStep
        onBack={isEdit ? undefined : () => setStep('choose')}
        onSuccess={props.onSuccess}
        onClose={props.onClose}
      />
    );
  }
  if (step === 'remoteHost') {
    return (
      <RemoteHostSetupStep
        onBack={() => setStep('choose')}
        onSuccess={props.onSuccess}
        onClose={props.onClose}
      />
    );
  }
  return (
    <ExternalServerStep
      {...props}
      isEdit={isEdit}
      onBack={isEdit ? undefined : () => setStep('choose')}
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
            icon={<HardDrive className="size-5" />}
            title="Run a server on this computer"
            description="switchdash sets up and runs the full Switch stack here with Docker. Best for trying Switch out."
            onClick={onLocal}
          />
          <ChoiceCard
            icon={<Server className="size-5" />}
            title="Run a server on a remote host"
            description="switchdash sets it up over SSH on a host you've onboarded. Stays running when switchdash is closed."
            onClick={onRemoteHost}
          />
          <ChoiceCard
            icon={<Globe className="size-5" />}
            title="Connect to an existing server"
            description="Point switchdash at a Switch gateway someone else runs, by URL."
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
  onSuccess,
  onClose,
}: {
  onBack?: () => void;
  onSuccess: () => void;
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
    if (running) onSuccess();
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
            <HardDrive className="size-5" />
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
            <AlertTitle>Setup failed</AlertTitle>
            <AlertDescription>{store.error}</AlertDescription>
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
            <LogTail lines={store.logs} />
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

function LogTail({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (lines.length === 0) return null;

  return (
    <div
      ref={ref}
      className="max-h-48 overflow-auto rounded-md border border-border bg-background-tertiary p-2 font-mono text-[11px] leading-relaxed text-foreground-muted"
    >
      {lines.map((line, i) => (
        // Log lines have no stable id; index is fine for an append-only tail.
        <div key={i} className="break-all whitespace-pre-wrap">
          {line}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2b — remote-host managed setup (pick an onboarded SSH host → start)
// ---------------------------------------------------------------------------

const RemoteHostSetupStep = observer(function RemoteHostSetupStep({
  onBack,
  onSuccess,
  onClose,
}: {
  onBack: () => void;
  onSuccess: () => void;
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

  const canStart = !!sshHost && name.trim().length > 0 && dockerReady && !starting;
  const primaryLabel = running ? 'Done' : status?.phase === 'error' ? 'Retry' : 'Start';
  const onPrimary = () => {
    if (running) onSuccess();
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
                  It's in your servers list, reachable from this computer while switchdash is open.
                </AlertDescription>
              </Alert>
            )}

            {store.error && !dockerUnavailable && !running && (
              <Alert variant="destructive">
                <AlertTitle>Setup failed</AlertTitle>
                <AlertDescription>{store.error}</AlertDescription>
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
                <LogTail lines={logs} />
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
}: Props & { isEdit: boolean; onBack?: () => void }) {
  const [name, setName] = useState(initialName ?? '');
  const [gatewayUrl, setGatewayUrl] = useState(initialGatewayUrl ?? '');
  const [apiUrl, setApiUrl] = useState(initialApiUrl ?? '');
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

  const handleSubmit = useCallback(async () => {
    if (!isValid) return;
    setSubmitting(true);
    setError(null);
    if (isEdit && serverId) {
      const result = await switchServersStore.updateServer(
        serverId,
        trimmedName,
        trimmedGateway,
        trimmedApi
      );
      if (!result) {
        setError(switchServersStore.error ?? 'Could not save the server.');
        setSubmitting(false);
        return;
      }
      notifyPropagation(result.propagation);
    } else {
      const saved = await switchServersStore.addServer(trimmedName, trimmedGateway, trimmedApi);
      if (!saved) {
        setError(switchServersStore.error ?? 'Could not add the server.');
        setSubmitting(false);
        return;
      }
    }
    onSuccess();
  }, [isValid, isEdit, serverId, trimmedName, trimmedGateway, trimmedApi, onSuccess]);

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>{isEdit ? 'Edit connection' : 'Connect to an existing server'}</DialogTitle>
      </DialogHeader>
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
          {submitting ? (isEdit ? 'Saving…' : 'Adding…') : isEdit ? 'Save changes' : 'Add server'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});
