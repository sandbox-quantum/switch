import { TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
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
import type { DeleteBridgeResult } from '@shared/core/switch-servers/switch-servers';

type DisconnectMessagingAppModalArgs = {
  serverId: string;
  bridgeId: string;
  bridgeDisplayName: string;
};

type Props = BaseModalProps<void> & DisconnectMessagingAppModalArgs;

/**
 * Confirm disconnecting a messaging app from a Switch server (CHOO-2137).
 *
 * "Disconnect" undersells it: the server deletes every Switch room on the
 * bridge before removing the bridge itself, so this is the most destructive
 * thing on the server page after deleting the server. It is guarded the same
 * way — type the name — because an accidental click here costs rooms, not a
 * setting.
 *
 * No room count is shown. The renderer's room list is what the signed-in user
 * is allowed to see, which is not necessarily every room on the bridge, and a
 * number that undercounts on a dialog like this is worse than no number.
 */
export const DisconnectMessagingAppModal = observer(function DisconnectMessagingAppModal({
  bridgeDisplayName,
  bridgeId,
  serverId,
  onSuccess,
  onClose,
}: Props) {
  const [confirmText, setConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typeConfirmed = confirmText.trim() === bridgeDisplayName.trim();

  const handleDelete = useCallback(async () => {
    if (!typeConfirmed) return;
    setIsDeleting(true);
    setError(null);
    try {
      const result = await rpc.switchServers.deleteBridge({ serverId, bridgeId });
      if (result.kind !== 'deleted') {
        setError(failureText(result));
        setIsDeleting(false);
        return;
      }
      onSuccess();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setIsDeleting(false);
    }
  }, [typeConfirmed, serverId, bridgeId, onSuccess]);

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-4 text-red-500" />
          <DialogTitle>Disconnect “{bridgeDisplayName}”?</DialogTitle>
        </div>
      </DialogHeader>
      <DialogContentArea className="space-y-3 pt-0">
        <p className="text-sm text-foreground-muted">
          This deletes <strong className="text-foreground">every Switch room on this app</strong>,
          along with their history, and then removes the connection. This can’t be undone.
        </p>
        <p className="text-sm text-foreground-muted">
          The channels in {bridgeDisplayName} are not deleted — they stay where they are, with
          nothing bridging them to Switch.
        </p>

        <FieldGroup>
          <Field>
            <FieldLabel>
              Type <span className="font-medium text-foreground">{bridgeDisplayName}</span> to
              confirm
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

        {error && <p className="text-destructive text-xs">{error}</p>}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isDeleting}>
          Cancel
        </Button>
        <ConfirmButton
          variant="destructive"
          onClick={() => void handleDelete()}
          disabled={!typeConfirmed || isDeleting}
        >
          {isDeleting ? 'Disconnecting…' : 'Disconnect app'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});

/** Turn a refused disconnect into something the user can act on. */
function failureText(result: Exclude<DeleteBridgeResult, { kind: 'deleted' }>): string {
  switch (result.kind) {
    case 'unauthenticated':
      return 'Your session for this server expired. Sign in again, then retry.';
    case 'forbidden':
      return 'Disconnecting a messaging app requires an admin account on this server.';
    case 'not-found':
      return 'That messaging app is no longer connected to this server.';
    case 'error':
      return result.message;
  }
}
