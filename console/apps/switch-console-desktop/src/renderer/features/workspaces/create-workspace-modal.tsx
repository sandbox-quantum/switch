import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useModalContext, type BaseModalProps } from '@renderer/lib/modal/modal-provider';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import type { Workspace } from '@shared/core/workspaces/workspaces';

type CreateWorkspaceModalArgs = {
  /** The server to create it on — the one the window is currently scoped to. */
  serverId: string;
};

type Props = BaseModalProps<Workspace> & CreateWorkspaceModalArgs;

/**
 * Make a workspace from the switcher.
 *
 * A workspace belongs to a server, so the first thing this has to be sure of is
 * which one. It opens on the server the window is already in and offers the
 * others only where there is a choice to make — on the ordinary single-server
 * install the question never appears.
 *
 * Only a server you are signed in to can be asked. Offering the rest and
 * letting Create come back with an authentication failure would blame the name
 * for something the name had nothing to do with, so the modal says which server
 * is not ready and keeps the button off.
 *
 * The design's address hint and "let my team join automatically" toggle are not
 * here: a Switch workspace has no subdomain of its own, and no server can yet
 * admit people by email domain. See the first-run create page, which leaves
 * them out for the same reasons.
 */
export const CreateWorkspaceModal = observer(function CreateWorkspaceModal({
  serverId,
  onSuccess,
  onClose,
}: Props) {
  const { transitionModal } = useModalContext();
  const [where, setWhere] = useState(serverId);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = switchServersStore.servers.filter((server) =>
    switchServersStore.isConnected(server.id)
  );
  const target = switchServersStore.serverById(where);
  const targetReady = target !== null && switchServersStore.isConnected(target.id);
  const trimmed = name.trim();

  const submit = async () => {
    if (!targetReady || trimmed === '' || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const workspace = await workspacesStore.create(where, trimmed);
      // Made and then entered: you asked for a workspace to work in, and
      // leaving the window in the old one would look like nothing happened.
      await workspacesStore.setActive(workspace.id);
      onSuccess(workspace);
    } catch (cause) {
      setError(failureText(cause, `${target?.name ?? 'That server'} could not create it.`));
      setSubmitting(false);
    }
  };

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Create a workspace</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <FieldGroup>
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
              placeholder="Weekend Robotics"
              autoFocus
            />
          </Field>

          {candidates.length > 1 && (
            <Field>
              <FieldLabel>Server</FieldLabel>
              <Select value={where} onValueChange={(value) => value && setWhere(value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((server) => (
                    <SelectItem key={server.id} value={server.id}>
                      {server.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          {targetReady ? (
            candidates.length > 1 ? null : (
              <p className="text-xs text-foreground-muted">
                It will live on {target.name}, along with its rooms and agents.
              </p>
            )
          ) : (
            <p className="text-xs text-destructive">
              {target === null
                ? 'That server is no longer registered on this computer.'
                : `You are not signed in to ${target.name}, so it cannot be asked to create anything. Sign in on its page first.`}
            </p>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}

          <p className="text-xs text-foreground-muted">
            Rather put it somewhere else?{' '}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => transitionModal('addServerModal', {})}
            >
              Add a server
            </button>
          </p>
        </FieldGroup>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <ConfirmButton
          onClick={() => void submit()}
          disabled={!targetReady || trimmed === '' || submitting}
        >
          {submitting ? 'Creating…' : 'Create workspace'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});
