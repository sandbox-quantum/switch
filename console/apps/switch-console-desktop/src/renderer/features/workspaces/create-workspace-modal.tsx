import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
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
import { createWorkspaceFailureText } from './describe-create-failure';

type CreateWorkspaceModalArgs = {
  /** The server to create it on — the one the window is currently scoped to. */
  serverId: string;
};

type Props = BaseModalProps<Workspace> & CreateWorkspaceModalArgs;

/**
 * Why a server cannot be asked to create a workspace, or null when it can.
 *
 * Three refusals rather than one, because the remedies are three different
 * things and only one of them is a password. Telling someone to sign in again
 * because the network is down misattributes an outage to their credentials,
 * which is the same mistake as blaming the name for an authentication failure —
 * the one this modal exists to avoid — with the arrow reversed.
 */
function whyNotReady(serverId: string): string | null {
  const server = switchServersStore.serverById(serverId);
  if (server === null) return 'That server is no longer registered on this computer.';
  if (!switchServersStore.statuses.has(serverId)) {
    return `Checking whether you’re signed in to ${server.name}…`;
  }
  if (switchServersStore.isUnreachable(serverId)) {
    return `${server.name} can’t be reached right now, so it can’t be asked to create anything.`;
  }
  if (!switchServersStore.isConnected(serverId)) {
    return `You are not signed in to ${server.name}, so it cannot be asked to create anything. Sign in on its page first.`;
  }
  return null;
}

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
  const { transitionModal, setCloseGuard } = useModalContext();
  const [chosen, setChosen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The workspace the gateway has already minted, when entering it is what
   * failed.
   *
   * Creating it again would ask for a name the server has just taken and come
   * back with a conflict that reads as the name being refused — so once this is
   * set the button stops offering to create and offers to open instead.
   */
  const [created, setCreated] = useState<Workspace | null>(null);

  const candidates = switchServersStore.servers.filter((server) =>
    switchServersStore.isConnected(server.id)
  );
  // The server the window is in, when it can be asked; otherwise the only one
  // that can. A default that is not a candidate would hide the picker on a
  // question the user still has to answer, and leave Create disabled with the
  // usable server offered nowhere.
  const fallback = candidates.some((server) => server.id === serverId)
    ? serverId
    : (candidates[0]?.id ?? serverId);
  const where = chosen ?? fallback;
  const target = switchServersStore.serverById(where);
  const notReady = whyNotReady(where);
  const trimmed = name.trim();

  // A status nobody has read yet leaves the modal saying "checking" forever,
  // since nothing else on screen is watching this server.
  useEffect(() => {
    if (!switchServersStore.statuses.has(where)) void switchServersStore.refreshStatus(where);
  }, [where]);

  const submit = async () => {
    if (submitting) return;
    if (created === null && (notReady !== null || trimmed === '')) return;
    setSubmitting(true);
    setCloseGuard(true);
    setError(null);
    try {
      const workspace = created ?? (await workspacesStore.create(where, trimmed));
      setCreated(workspace);
      // Made and then entered: you asked for a workspace to work in, and
      // leaving the window in the old one would look like nothing happened.
      await workspacesStore.setActive(workspace.id);
      onSuccess(workspace);
    } catch (cause) {
      // Two different failures wear the same button. Before the workspace
      // exists the likeliest one is the name, and after it exists the name is
      // settled and what failed was the move into it — saying "could not
      // create" then would be describing the wrong step.
      setError(
        created === null
          ? createWorkspaceFailureText(
              cause,
              target?.name ?? 'that server',
              `${target?.name ?? 'That server'} could not create it.`
            )
          : failureText(cause, `This window could not be moved into ${created.name}.`)
      );
      setSubmitting(false);
    } finally {
      setCloseGuard(false);
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
              disabled={created !== null}
            />
          </Field>

          {candidates.length > 1 && (
            <Field>
              <FieldLabel>Server</FieldLabel>
              <Select
                value={where}
                onValueChange={(value) => value && setChosen(value)}
                disabled={submitting || created !== null}
              >
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

          {created !== null ? (
            <p className="text-xs text-foreground-muted">
              {created.name} was created on {target?.name ?? 'the server'}, but this window could
              not be moved into it. Try again, or close this and pick it from the switcher.
            </p>
          ) : notReady !== null ? (
            <p className="text-xs text-destructive">{notReady}</p>
          ) : target !== null && candidates.length <= 1 ? (
            <p className="text-xs text-foreground-muted">
              It will live on {target.name}, along with its rooms and agents.
            </p>
          ) : null}

          {error && <p className="text-xs text-destructive">{error}</p>}

          <p className="text-xs text-foreground-muted">
            Rather put it somewhere else?{' '}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
              disabled={submitting || created !== null}
              onClick={() => transitionModal('addServerModal', {})}
            >
              Add a server
            </button>
          </p>
        </FieldGroup>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={submitting}>
          {created === null ? 'Cancel' : 'Close'}
        </Button>
        <ConfirmButton
          onClick={() => void submit()}
          /* Entering a workspace that already exists is a local move, so once it
             has been created the server's readiness stops being the question. */
          disabled={submitting || (created === null && (notReady !== null || trimmed === ''))}
        >
          {created !== null
            ? submitting
              ? 'Opening…'
              : 'Open workspace'
            : submitting
              ? 'Creating…'
              : 'Create workspace'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});
