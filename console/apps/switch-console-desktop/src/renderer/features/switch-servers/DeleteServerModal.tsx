import { TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
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
import { othersRecentlySeen } from '@shared/core/managed-switch-server/managed-switch-server';
import { remoteServerStore } from './remote-server-store';
import { affectedSentence } from './shared-consoles';
import { switchServersStore } from './switch-servers-store';

type DeleteServerModalArgs = {
  serverId: string;
};

type Props = BaseModalProps<void> & DeleteServerModalArgs;

/** What removing a server Switch Console runs on a remote host does: stop
 * using it from here, or destroy it for everyone (CHOO-2893). */
type RemoteRemoval = 'disconnect' | 'delete';

function countLinkedAgents(serverId: string): number {
  let count = 0;
  for (const agents of agentsStore.byLocation.values()) {
    count += agents.filter((a) => a.serverId === serverId).length;
  }
  return count;
}

function RemovalChoice({
  selected,
  title,
  children,
  onSelect,
}: {
  selected: boolean;
  title: string;
  children: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`w-full space-y-0.5 rounded-md border p-3 text-left ${
        selected
          ? 'border-primary bg-background-tertiary-2'
          : 'border-border hover:bg-background-tertiary-2'
      }`}
    >
      <span className="block text-sm font-medium text-foreground">{title}</span>
      <span className="block text-xs text-foreground-muted">{children}</span>
    </button>
  );
}

export const DeleteServerModal = observer(function DeleteServerModal({
  serverId,
  onSuccess,
  onClose,
}: Props) {
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  const [linkedAgents, setLinkedAgents] = useState(() => countLinkedAgents(serverId));
  const [confirmText, setConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Leaving is the default: on a shared host the stack is other people's too,
  // and destroying it has to be chosen, not fallen into.
  const [removal, setRemoval] = useState<RemoteRemoval>('disconnect');

  useEffect(() => {
    void agentsStore.load().then(() => setLinkedAgents(countLinkedAgents(serverId)));
  }, [serverId]);

  const managed = server?.managed ?? false;
  const remoteHost =
    server?.managed && server.managementKind === 'remote' && server.sshHost ? server.sshHost : null;

  // The server page has usually read it already; only a cold open asks the host.
  useEffect(() => {
    if (remoteHost && !remoteServerStore.registerFor(remoteHost)) {
      void remoteServerStore.loadRegister(remoteHost);
    }
  }, [remoteHost]);

  const destroying = managed && (remoteHost === null || removal === 'delete');
  // Destroying a stack tears down real infrastructure and data, so it is
  // guarded with a type-the-name confirmation. Letting go of one is not.
  const needsTypeConfirm = destroying;
  const typeConfirmed = !needsTypeConfirm || confirmText.trim() === (server?.name ?? '').trim();

  const handleDelete = useCallback(async () => {
    if (!server || !typeConfirmed) return;
    setIsDeleting(true);
    setError(null);
    const ok =
      remoteHost && removal === 'disconnect'
        ? await remoteServerStore.disconnect(remoteHost, serverId)
        : await switchServersStore.deleteServer(serverId);
    if (ok) {
      onSuccess();
    } else {
      setError(
        (remoteHost && removal === 'disconnect'
          ? remoteServerStore.errorText
          : switchServersStore.errorText) ?? 'Could not remove the server.'
      );
      setIsDeleting(false);
    }
  }, [server, typeConfirmed, remoteHost, removal, serverId, onSuccess]);

  if (!server) {
    return (
      <>
        <DialogHeader showCloseButton={false}>
          <DialogTitle>Remove server</DialogTitle>
        </DialogHeader>
        <DialogContentArea className="pt-0">
          <p className="text-sm text-foreground-muted">This server is no longer available.</p>
        </DialogContentArea>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }

  const agentsNote =
    linkedAgents === 0
      ? 'No agents are linked to it.'
      : `${linkedAgents} linked ${linkedAgents === 1 ? 'agent' : 'agents'} will be unlinked but kept — you can re-link them to another server.`;
  const others = remoteHost
    ? othersRecentlySeen(remoteServerStore.registerFor(remoteHost), new Date())
    : [];

  const title = remoteHost
    ? `Remove “${server.name}”?`
    : managed
      ? `Delete “${server.name}”?`
      : `Disconnect from “${server.name}”?`;
  const actionLabel = destroying
    ? isDeleting
      ? 'Deleting…'
      : remoteHost
        ? 'Delete for everyone'
        : 'Delete server'
    : isDeleting
      ? 'Disconnecting…'
      : 'Disconnect';

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-4 text-red-500" />
          <DialogTitle>{title}</DialogTitle>
        </div>
      </DialogHeader>
      <DialogContentArea className="space-y-3 pt-0">
        {remoteHost ? (
          <div role="radiogroup" className="space-y-2">
            <RemovalChoice
              selected={removal === 'disconnect'}
              title="Disconnect this Console"
              onSelect={() => setRemoval('disconnect')}
            >
              Switch Console stops using the server and forgets its credentials. It keeps running on{' '}
              {remoteHost} for everyone else, with all its rooms, agents and data — you can connect
              to it again later.
            </RemovalChoice>
            <RemovalChoice
              selected={removal === 'delete'}
              title="Delete it for everyone"
              onSelect={() => setRemoval('delete')}
            >
              Tears down the stack on {remoteHost} — its containers,{' '}
              <strong className="text-foreground">all data and secrets</strong> — for everyone who
              uses it. This can’t be undone.
            </RemovalChoice>
          </div>
        ) : managed ? (
          <p className="text-sm text-foreground-muted">
            This permanently tears down the managed stack on this computer — its containers,{' '}
            <strong className="text-foreground">all data and secrets</strong> — and removes it from
            Switch Console. This can’t be undone.
          </p>
        ) : (
          <p className="text-sm text-foreground-muted">
            This disconnects Switch Console from the server and signs you out of it. The server
            itself isn’t touched — you can connect to it again later.
          </p>
        )}
        {destroying && remoteHost && affectedSentence(others, new Date()) && (
          <p className="text-sm text-foreground-muted">{affectedSentence(others, new Date())}</p>
        )}
        <p className="text-sm text-foreground-muted">{agentsNote}</p>

        {needsTypeConfirm && (
          <FieldGroup>
            <Field>
              <FieldLabel>
                Type <span className="font-medium text-foreground">{server.name}</span> to confirm
              </FieldLabel>
              <Input
                value={confirmText}
                onChange={(e) => {
                  setConfirmText(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && typeConfirmed) void handleDelete();
                }}
                autoFocus
              />
            </Field>
          </FieldGroup>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <ConfirmButton
          variant="destructive"
          onClick={() => void handleDelete()}
          disabled={!typeConfirmed || isDeleting}
        >
          {actionLabel}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});
