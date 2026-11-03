import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, Server, Terminal } from 'lucide-react';
import { useEffect, useReducer, useRef, useState } from 'react';
import { CopyButton } from '@renderer/features/admin/copy-button';
import {
  MANAGED_AGENTS_KEY,
  useOwnedMachines,
} from '@renderer/features/managed-agents/use-managed-agents';
import { REMOTE_HOSTS_QUERY_KEY } from '@renderer/features/remote-hosts/views/remote-hosts-view';
import { invalidateHostProviderReadiness } from '@renderer/lib/components/provider-connection-status';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { useCloseGuard } from '@renderer/lib/modal/use-close-guard';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Input } from '@renderer/lib/ui/input';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Spinner } from '@renderer/lib/ui/spinner';
import { enrollCommands } from './device-model';

type Choice = 'this-computer' | 'ssh-host' | 'command-line';

/**
 * Adding a device to run agents on: this computer, an SSH host this Console
 * reaches (Console installs and enrolls the controller there), or any other
 * computer, enrolled from its own command line with a one-time code.
 */
export function AddDeviceDialog({
  serverId,
  workspaceId,
  onSuccess,
  onClose,
}: { serverId: string; workspaceId: string } & BaseModalProps) {
  const machines = useOwnedMachines(serverId);
  const thisComputerAdded =
    machines.data?.some((machine) => machine.local?.kind === 'this-computer') ?? false;
  const [picked, setPicked] = useState<Choice | null>(null);
  // Until the person picks, the dialog opens where it can do something: the
  // machines may still be loading when it first renders.
  const choice: Choice = picked ?? (thisComputerAdded ? 'command-line' : 'this-computer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sshHost, setSshHost] = useState<string | null>(null);
  const queryClient = useQueryClient();
  useCloseGuard(busy);
  const hosts = useQuery({
    queryKey: REMOTE_HOSTS_QUERY_KEY,
    queryFn: () => rpc.remoteHosts.listHosts(),
  });
  const hostsToAdd = (hosts.data ?? []).filter(
    (host) =>
      !machines.data?.some(
        (machine) => machine.local?.kind === 'ssh-host' && machine.local.sshHost === host.sshHost
      )
  );

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      if (choice === 'ssh-host' && sshHost) {
        await rpc.hostControllers.enable({ sshHost, serverId, workspaceId });
        // Making it a device puts Switch's shared host there, which is what
        // checks a provider's sign-in on it.
        void invalidateHostProviderReadiness(queryClient, sshHost);
        void queryClient.invalidateQueries({ queryKey: REMOTE_HOSTS_QUERY_KEY });
      } else await rpc.embeddedController.enable({ serverId, workspaceId });
      await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY] });
      onSuccess(undefined);
    } catch (cause) {
      setError(
        failureText(
          cause,
          choice === 'ssh-host'
            ? `Could not set ${sshHost} up to run agents.`
            : 'Could not set this computer up to run agents.'
        )
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader showCloseButton={!busy}>
        <DialogTitle>Add a device</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
        <SegmentedControl
          ariaLabel="Which device"
          value={choice}
          onChange={(value) => {
            setPicked(value);
            setError(null);
          }}
          options={[
            { value: 'this-computer', label: 'This computer', icon: Laptop },
            { value: 'ssh-host', label: 'SSH host', icon: Server },
            { value: 'command-line', label: 'Another computer', icon: Terminal },
          ]}
        />
        {choice === 'this-computer' &&
          (thisComputerAdded ? (
            <p className="text-sm text-foreground-muted">
              This computer is one of your devices already.
            </p>
          ) : (
            <p className="text-sm text-foreground-muted">
              Console runs an agent controller for this server while it is open, so agents placed
              here run on this computer.
            </p>
          ))}
        {choice === 'ssh-host' && (
          <>
            <p className="text-sm text-foreground-muted">
              Console installs an agent controller on the host over SSH and keeps it running there.
            </p>
            {hosts.isPending ? (
              <p className="flex items-center gap-2 text-sm">
                <Spinner /> Loading your SSH hosts…
              </p>
            ) : hostsToAdd.length === 0 ? (
              <p className="text-sm text-foreground-muted">
                Every SSH host this Console reaches is a device already. Add a host under SSH hosts
                in Your devices first.
              </p>
            ) : (
              <Select value={sshHost} onValueChange={(value) => setSshHost(value)}>
                <SelectTrigger className="w-full" aria-label="SSH host">
                  <SelectValue>{sshHost ?? 'Choose a host'}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {hostsToAdd.map((host) => (
                    <SelectItem key={host.sshHost} value={host.sshHost}>
                      {host.sshHost}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </>
        )}
        {choice === 'command-line' && <CommandLineEnrollment serverId={serverId} />}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContentArea>
      <DialogFooter>
        {choice === 'command-line' ? (
          <Button onClick={() => onSuccess(undefined)}>Done</Button>
        ) : (
          <>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={
                busy ||
                (choice === 'this-computer' && thisComputerAdded) ||
                (choice === 'ssh-host' && !sshHost)
              }
              onClick={() => void enable()}
            >
              {busy && <Spinner />}
              Add device
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}

/**
 * The commands that enroll another computer, with a fresh one-time code. The
 * code lasts ten minutes and enrolls one computer; a new one can be had at
 * any time. Without a public address on the server no command could reach it,
 * so the dialog says that instead.
 */
function CommandLineEnrollment({ serverId }: { serverId: string }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // A mutation, not a query: each code is a new live credential on the server,
  // so it is issued once when this opens and again only on "New code", never
  // by a cache refresh while the person is copying the commands.
  const { mutate: issueCode, ...enrollment } = useMutation({
    mutationFn: () => rpc.managedAgents.enrollmentCode(serverId),
  });
  const issued = useRef(false);
  useEffect(() => {
    if (issued.current) return;
    issued.current = true;
    issueCode();
  }, [issueCode]);
  const expiresAt = enrollment.data?.expiresAt;
  // Nothing else re-renders the dialog when the code runs out.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(
      rerender,
      Math.max(0, new Date(expiresAt).getTime() - Date.now()) + 500
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);
  if (enrollment.isIdle || enrollment.isPending)
    return (
      <p className="flex items-center gap-2 text-sm">
        <Spinner /> Getting a one-time code…
      </p>
    );
  if (enrollment.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        {failureText(enrollment.error, 'Could not get a code to enroll a computer with.')}
      </p>
    );
  const { code, serverUrl } = enrollment.data;
  const validUntil = new Date(enrollment.data.expiresAt);
  const expired = validUntil.getTime() <= Date.now();
  return (
    <div className="space-y-3 text-sm">
      <p className="text-foreground-muted">
        Run one of these on the computer. It installs the agent controller, enrolls it as your
        device and keeps it running as a service. macOS and Linux; on Windows, use Console there.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Input
          placeholder="Name (defaults to its host name)"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Input
          placeholder="Description (optional)"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      {serverUrl === null ? (
        <p role="alert" className="text-destructive">
          This server has no public address set (GATEWAY_PUBLIC_URL), so a computer could not reach
          it to enroll. Ask whoever runs it to set one.
        </p>
      ) : (
        (() => {
          const commands = enrollCommands({ serverUrl, code, name, description });
          return (
            <>
              <CommandBlock label="Install, enroll and start" command={commands.install} />
              <CommandBlock label="Already installed" command={commands.enroll} />
            </>
          );
        })()
      )}
      <div className="flex items-center gap-2 text-xs text-foreground-muted">
        <span>
          One-time code <span className="font-mono text-foreground">{code}</span>
          {expired
            ? ' has expired: get a new one before running the commands.'
            : `, valid until ${validUntil.toLocaleTimeString()}.`}
        </span>
        <Button size="sm" variant="ghost" onClick={() => issueCode()}>
          New code
        </Button>
      </div>
      <p className="text-xs text-foreground-muted">
        If the computer does not show up in Your devices, run{' '}
        <span className="font-mono">switch-agent-controller doctor</span> on it.
      </p>
    </div>
  );
}

function CommandBlock({ label, command }: { label: string; command: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-foreground-muted">{label}</div>
      <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5">
        <code className="min-w-0 flex-1 font-mono text-xs break-all">{command}</code>
        <CopyButton value={command} />
      </div>
    </div>
  );
}
