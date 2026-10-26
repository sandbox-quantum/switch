import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CopyButton } from '@renderer/features/admin/copy-button';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { Spinner } from '@renderer/lib/ui/spinner';
import {
  enrollCommand,
  installCommand,
  MAX_MACHINE_DESCRIPTION,
  MAX_MACHINE_NAME,
} from '@shared/core/managed-agents/machine-enrollment';

type Props = BaseModalProps<void> & { serverId: string };

/**
 * How to add a machine: run the agents controller on it and enroll it with a
 * one-time code, issued when the dialog opens. The code is shown once:
 * closing discards it, and opening again issues a new one. The optional name
 * and description go into the commands, so the machine enrolls with them.
 */
export function AddMachineModal({ serverId, onClose }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // A fresh code each time the dialog opens, never one from the cache.
  const [opening] = useState(() => crypto.randomUUID());
  const enrollment = useQuery({
    queryKey: ['machine-enrollment', serverId, opening],
    queryFn: () => rpc.managedAgents.machineEnrollment(serverId),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const nameTooLong = name.trim().length > MAX_MACHINE_NAME;
  const descriptionTooLong = description.trim().length > MAX_MACHINE_DESCRIPTION;
  const issued = enrollment.data;
  const machine = { name, description };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add a device</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
        <DialogDescription>
          Run the agents controller on the computer that should run your agents: a laptop, your own
          VM or a server. Enroll it once with the code below, and it runs whatever agents you place
          on it. It needs Linux or macOS with Node 22.13 or later, and the CLI of each provider your
          agents use, signed in as the user the controller runs as.
        </DialogDescription>
        {enrollment.error ? (
          <p role="alert" className="text-sm text-destructive">
            {failureText(enrollment.error, 'Could not issue an enrollment code.')}
          </p>
        ) : !issued ? (
          <Spinner />
        ) : (
          <>
            <FieldGroup>
              <Field>
                <FieldLabel>Name (optional)</FieldLabel>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Defaults to the device's host name"
                />
                {nameTooLong && (
                  <p className="mt-1 text-xs text-destructive">
                    At most {MAX_MACHINE_NAME} characters.
                  </p>
                )}
              </Field>
              <Field>
                <FieldLabel>Description (optional)</FieldLabel>
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What it is for, such as the build box in the office"
                />
                {descriptionTooLong && (
                  <p className="mt-1 text-xs text-destructive">
                    At most {MAX_MACHINE_DESCRIPTION} characters.
                  </p>
                )}
              </Field>
            </FieldGroup>

            {issued.loopback && (
              <p className="rounded-md border border-border bg-background-1 px-3 py-2 text-xs text-foreground-muted">
                This server is at {issued.serverUrl}, which only this computer can reach. Another
                device needs an address it can reach Switch at: change <code>--server</code> to
                that.
              </p>
            )}

            {nameTooLong || descriptionTooLong ? (
              <p className="text-sm text-foreground-muted">
                Shorten the name or description to see the commands.
              </p>
            ) : (
              <>
                <CommandBlock
                  title="Install, enroll and start"
                  command={installCommand(issued.serverUrl, issued.code, machine)}
                  note="Installs the newest controller with npm, enrolls the device, and runs the controller as a service of your user."
                />
                <CommandBlock
                  title="Already installed"
                  command={enrollCommand(issued.serverUrl, issued.code, machine)}
                  note="Then start it with switch-agent-controller install-service."
                />
              </>
            )}

            <p className="text-xs text-foreground-muted">
              The code is single use and valid until{' '}
              {new Date(issued.expiresAt).toLocaleTimeString()}. The device shows up in Settings →
              Devices once its controller reports; if it does not, run{' '}
              <code>switch-agent-controller doctor</code> on it. A computer you reach over SSH can
              also join without this: create an agent on it, and Switch Console sets its controller
              up.
            </p>
          </>
        )}
      </DialogContentArea>
      <DialogFooter>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </>
  );
}

function CommandBlock({ title, command, note }: { title: string; command: string; note: string }) {
  return (
    <div>
      <h4 className="mb-1 text-sm font-medium text-foreground">{title}</h4>
      <div className="flex items-start gap-1 rounded-md bg-background-1 px-3 py-2">
        <code className="min-w-0 flex-1 font-mono text-xs break-all text-foreground select-all">
          {command}
        </code>
        <CopyButton value={command} />
      </div>
      <p className="mt-1 text-xs text-foreground-muted">{note}</p>
    </div>
  );
}
