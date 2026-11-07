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
import type { Workspace } from '@shared/core/workspaces/workspaces';
import { createWorkspaceFailureText } from './describe-create-failure';

/**
 * What is being created.
 *
 * - `organization`: an organization with a first workspace of the same name,
 *   which is what creating means on a server with organizations.
 * - `workspace`: a workspace on its own, on a server from before them.
 * - `organization-workspace`: another workspace in an organization the account
 *   is an `org_admin` of, asked for through `through`, one of its workspaces.
 */
export type CreateTarget =
  | { kind: 'organization' }
  | { kind: 'workspace' }
  | { kind: 'organization-workspace'; through: string; organizationName: string | null };

type CreateWorkspaceModalArgs = {
  /** The server to create it on: the one whose group the action was chosen in. */
  serverId: string;
  target: CreateTarget;
};

function title(target: CreateTarget, serverName: string | null): string {
  switch (target.kind) {
    case 'organization':
      return serverName ? `Create an organization on ${serverName}` : 'Create an organization';
    case 'workspace':
      return serverName ? `Create a workspace on ${serverName}` : 'Create a workspace';
    case 'organization-workspace':
      return target.organizationName
        ? `Add a workspace to ${target.organizationName}`
        : 'Add a workspace to your organization';
  }
}

function placement(target: CreateTarget, serverName: string): string {
  switch (target.kind) {
    case 'organization':
      return `It will live on ${serverName}, with a first workspace of the same name for its rooms and agents. You can add more workspaces to it later.`;
    case 'workspace':
      return `It will live on ${serverName}, along with its rooms and agents.`;
    case 'organization-workspace':
      return `You will own it, and every admin of ${target.organizationName ?? 'the organization'} can manage it.`;
  }
}

type Props = BaseModalProps<Workspace> & CreateWorkspaceModalArgs;

const CONFIRM_LABEL: Record<CreateTarget['kind'], string> = {
  organization: 'Create organization',
  workspace: 'Create workspace',
  'organization-workspace': 'Add workspace',
};

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
 * Make an organization, or a workspace in one, from the switcher.
 *
 * Both belong to a server, and the switcher has already said which: each
 * server's group ends with its own Create organization, and each organization
 * an `org_admin` runs with its own Add workspace, so this asks only for the
 * name.
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
  target: creating,
  onSuccess,
  onClose,
}: Props) {
  const { transitionModal, setCloseGuard } = useModalContext();
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

  const where = serverId;
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
      const workspace =
        created ??
        (creating.kind === 'organization-workspace'
          ? await workspacesStore.addToOrganization(creating.through, trimmed)
          : await workspacesStore.create(where, trimmed));
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
        <DialogTitle>{title(creating, target?.name ?? null)}</DialogTitle>
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

          {created !== null ? (
            <p className="text-xs text-foreground-muted">
              {created.name} was created on {target?.name ?? 'the server'}, but this window could
              not be moved into it. Try again, or close this and pick it from the switcher.
            </p>
          ) : notReady !== null ? (
            <p className="text-xs text-destructive">{notReady}</p>
          ) : target !== null ? (
            <p className="text-xs text-foreground-muted">{placement(creating, target.name)}</p>
          ) : null}

          {error && <p className="text-xs text-destructive">{error}</p>}

          {creating.kind !== 'organization-workspace' && (
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
          )}
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
              : CONFIRM_LABEL[creating.kind]}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});
