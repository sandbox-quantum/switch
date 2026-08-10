/**
 * Adding a remote host (CHOO-1809).
 *
 * This was an inline form living in the page header's action slot — a slot
 * sized for a button — so it rendered as a cramped box wedged beside the filter
 * tabs. It is a data-entry step like adding a server or an agent, and it now
 * looks like one.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Spinner } from '@renderer/lib/ui/spinner';
import { log } from '@renderer/utils/logger';

export type AddHostModalProps = BaseModalProps<void> & {
  /** Aliases already onboarded, so the picker does not offer duplicates. */
  onboarded: string[];
  onAdded: (sshHost: string) => void;
};

/** Suggest a display name from the alias, so the second field is rarely work. */
function suggestName(alias: string): string {
  return alias
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function AddHostModal({ onboarded, onAdded, onClose }: AddHostModalProps) {
  const [sshHost, setSshHost] = useState('');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);

  const configHosts = useQuery({
    queryKey: ['ssh-config-hosts'],
    queryFn: () => rpc.remoteHosts.listSshConfigHosts(),
  });

  const available = useMemo(
    () => (configHosts.data ?? []).filter((alias) => !onboarded.includes(alias)),
    [configHosts.data, onboarded]
  );

  const chooseHost = (alias: string) => {
    setSshHost(alias);
    if (!nameEdited) setName(suggestName(alias));
  };

  const mutation = useMutation({
    mutationFn: () => rpc.remoteHosts.onboardHost({ sshHost: sshHost.trim(), name: name.trim() }),
    onError: (error) => log.error('Failed to onboard remote host', { sshHost, error }),
    onSuccess: (host) => {
      onAdded(host.sshHost);
      onClose();
    },
  });

  const canSubmit = sshHost.trim().length > 0 && name.trim().length > 0 && !mutation.isPending;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add a remote host</DialogTitle>
      </DialogHeader>

      <DialogContentArea>
        <FieldGroup>
          <Field>
            <FieldLabel>SSH host</FieldLabel>
            <p className="text-xs text-foreground-muted">
              A Host alias from your <code>~/.ssh/config</code>. Auth uses your SSH agent — Switch
              Console stores no credentials.
            </p>
            {/*
              Wait for the alias list before choosing which control to show.
              Swapping a text input for a select once the query resolves used to
              discard whatever the user had already typed.
            */}
            {configHosts.isLoading ? (
              <div className="flex items-center gap-2 text-xs text-foreground-muted">
                <Spinner /> Reading ~/.ssh/config…
              </div>
            ) : available.length > 0 ? (
              <Select value={sshHost} onValueChange={(value) => chooseHost(value ?? '')}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a host alias" />
                </SelectTrigger>
                <SelectContent>
                  {available.map((alias) => (
                    <SelectItem key={alias} value={alias}>
                      {alias}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <>
                <Input
                  value={sshHost}
                  placeholder="dev-vm"
                  onChange={(event) => chooseHost(event.target.value)}
                />
                <p className="text-xs text-foreground-muted">
                  {(configHosts.data ?? []).length === 0
                    ? 'No aliases found in ~/.ssh/config — type one to add it anyway.'
                    : 'Every alias in ~/.ssh/config is already onboarded.'}
                </p>
              </>
            )}
          </Field>

          <Field>
            <FieldLabel>Display name</FieldLabel>
            <Input
              value={name}
              placeholder="Dev VM"
              onChange={(event) => {
                setNameEdited(true);
                setName(event.target.value);
              }}
            />
          </Field>

          {mutation.isError && (
            <p className="text-destructive text-xs">{(mutation.error as Error).message}</p>
          )}
        </FieldGroup>
      </DialogContentArea>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
          Cancel
        </Button>
        <Button onClick={() => mutation.mutate()} disabled={!canSubmit}>
          {mutation.isPending ? (
            <>
              <Spinner /> Verifying…
            </>
          ) : (
            <>
              <Plus className="size-4" /> Add host
            </>
          )}
        </Button>
      </DialogFooter>
    </>
  );
}
