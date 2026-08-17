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
import { switchServersStore } from './switch-servers-store';

type DeleteServerModalArgs = {
  serverId: string;
};

type Props = BaseModalProps<void> & DeleteServerModalArgs;

function countLinkedAgents(serverId: string): number {
  let count = 0;
  for (const agents of agentsStore.byLocation.values()) {
    count += agents.filter((a) => a.serverId === serverId).length;
  }
  return count;
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

  useEffect(() => {
    void agentsStore.load().then(() => setLinkedAgents(countLinkedAgents(serverId)));
  }, [serverId]);

  const managed = server?.managed ?? false;
  // Managed delete tears down real infrastructure and data, so guard it with a
  // type-the-name confirmation. External delete is a reversible de-register.
  const needsTypeConfirm = managed;
  const typeConfirmed = !needsTypeConfirm || confirmText.trim() === (server?.name ?? '').trim();

  const handleDelete = useCallback(async () => {
    if (!server || !typeConfirmed) return;
    setIsDeleting(true);
    setError(null);
    const ok = await switchServersStore.deleteServer(serverId);
    if (ok) {
      onSuccess();
    } else {
      setError(switchServersStore.error ?? 'Failed to delete server.');
      setIsDeleting(false);
    }
  }, [server, typeConfirmed, serverId, onSuccess]);

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

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-4 text-red-500" />
          <DialogTitle>
            {managed ? `Delete “${server.name}”?` : `Disconnect from “${server.name}”?`}
          </DialogTitle>
        </div>
      </DialogHeader>
      <DialogContentArea className="space-y-3 pt-0">
        {managed ? (
          <p className="text-sm text-foreground-muted">
            This permanently tears down the managed stack{' '}
            {server.managementKind === 'remote' && server.sshHost
              ? `on ${server.sshHost}`
              : 'on this computer'}{' '}
            — its containers, <strong className="text-foreground">all data and secrets</strong> —
            and removes it from Switch Console. This can’t be undone.
          </p>
        ) : (
          <p className="text-sm text-foreground-muted">
            This disconnects Switch Console from the server and signs you out of it. The server
            itself isn’t touched — you can connect to it again later.
          </p>
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

        {error && <p className="text-destructive text-xs">{error}</p>}
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
          {managed
            ? isDeleting
              ? 'Deleting…'
              : 'Delete server'
            : isDeleting
              ? 'Disconnecting…'
              : 'Disconnect'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});
