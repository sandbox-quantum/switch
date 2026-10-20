import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { ConnectedChat } from '@shared/core/switch-servers/switch-servers';

/**
 * The chats under a connection whose chats are connected one at a time (the
 * Switch Telegram app). A Slack workspace or Discord server is a connection of
 * its own, and so a row of its own; these share one connection, so they are
 * listed under it.
 *
 * Anyone may disconnect one, not only an admin: a chat is a room, and rooms
 * are members'. The connection stays when the last one goes.
 */
export function ConnectedChatsList({
  workspaceId,
  bridgeId,
  platformLabel,
  onDisconnected,
}: {
  workspaceId: string;
  bridgeId: string;
  platformLabel: string;
  onDisconnected: () => void;
}) {
  const queryClient = useQueryClient();
  const showConfirm = useShowModal('confirmActionModal');
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chatsQuery = useQuery({
    queryKey: ['connected-chats', workspaceId, bridgeId],
    queryFn: () => rpc.workspaces.listConnectedChats({ workspaceId, bridgeId }),
  });

  const disconnect = async (chat: ConnectedChat) => {
    setDisconnectingId(chat.id);
    setError(null);
    try {
      await rpc.workspaces.disconnectChat({ workspaceId, installId: chat.id });
      await queryClient.invalidateQueries({ queryKey: ['connected-chats', workspaceId] });
      onDisconnected();
    } catch (cause) {
      setError(failureText(cause, `Could not disconnect ${chatName(chat)}.`));
    } finally {
      setDisconnectingId(null);
    }
  };

  const confirmDisconnect = (chat: ConnectedChat) =>
    showConfirm({
      title: `Disconnect ${chatName(chat)}?`,
      description: `The bot leaves the chat. Its room stays in Switch, with nothing bridging it to ${platformLabel}.`,
      confirmLabel: 'Disconnect',
      onSuccess: () => void disconnect(chat),
    });

  const chats = chatsQuery.data ?? [];

  return (
    <div className="flex flex-col pb-1 pl-8">
      {chatsQuery.isLoading && <Spinner className="size-3.5" />}
      {chatsQuery.isError && (
        <p className="text-xs text-destructive">
          {failureText(chatsQuery.error, 'Could not load the chats connected here.')}
        </p>
      )}
      {chatsQuery.isSuccess && chats.length === 0 && (
        <p className="text-xs text-foreground-muted">No chats connected.</p>
      )}
      {chats.map((chat) => (
        <div key={chat.id} className="flex items-center gap-2 py-0.5 text-xs">
          <span
            className={`min-w-0 flex-1 truncate text-foreground ${chat.name === null ? 'font-mono' : ''}`}
            title={chat.externalId}
          >
            {chatName(chat)}
          </span>
          <RelativeTime value={chat.connectedAt} className="shrink-0 text-foreground-muted" />
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0"
            disabled={disconnectingId !== null}
            onClick={() => confirmDisconnect(chat)}
          >
            {disconnectingId === chat.id ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </div>
      ))}
      {error !== null && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function chatName(chat: ConnectedChat): string {
  return chat.name ?? chat.externalId;
}
