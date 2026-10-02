import { useQuery } from '@tanstack/react-query';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useOnUnmount } from '@renderer/lib/hooks/use-on-unmount';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Spinner } from '@renderer/lib/ui/spinner';
import { ChatClaimDetails } from './ConnectChatPanel';

type ConnectChatModalArgs = {
  workspaceId: string;
  platform: string;
  /** Run however the dialog goes away. The chat's room is made in the chat,
   *  on no signal Switch Console receives, so this is when to look for it. */
  onClosed: () => void;
};

type Props = BaseModalProps<void> & ConnectChatModalArgs;

/**
 * Connect one more chat to a connection that already exists, from its row in
 * Messaging apps. Open to members as well as admins: once a workspace has the
 * connection, a chat is a room, and rooms are members'.
 *
 * The claim is minted when the dialog opens and never again while it stays
 * open — each one is a new code, and a refetch on focus would quietly swap the
 * one the user is halfway through pasting.
 *
 * Goes through the modal registry because it is opened from the row's
 * dropdown, which unmounts anything rendered inside it as it closes.
 */
export function ConnectChatModal({ workspaceId, platform, onClosed, onClose }: Props) {
  const label = bridgePlatformLabel(platform);
  useOnUnmount(onClosed);
  const claimQuery = useQuery({
    queryKey: ['chat-claim', workspaceId, platform],
    queryFn: () => rpc.workspaces.beginChatClaim({ workspaceId, platform }),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add to {label}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        {claimQuery.isLoading && <Spinner className="size-4" />}
        {claimQuery.isError && (
          <p className="text-xs text-destructive">
            {failureText(claimQuery.error, `Could not start connecting a ${label} chat.`)}
          </p>
        )}
        {claimQuery.data && <ChatClaimDetails platform={platform} claim={claimQuery.data} />}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}
