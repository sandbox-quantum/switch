import { observer } from 'mobx-react-lite';
import { serverState } from '@renderer/features/switch-servers/server-presentation';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { chatsStore } from '../stores/chats';

/**
 * Beside a server that reads as connected: its chat feed is not. The server
 * answering does not mean chats are live, and saying only "Connected" while
 * every chat shows Offline would contradict it.
 */
export const ChatsOfflineNote = observer(function ChatsOfflineNote({
  server,
}: {
  server: SwitchServer;
}) {
  const state = serverState(server);
  if (state !== 'connected' && state !== 'running-local') return null;
  if (chatsStore.serverId !== server.id || chatsStore.streamState !== 'offline') return null;
  return (
    <span
      className="shrink-0 text-foreground-warning"
      title={chatsStore.streamDetail ?? 'The live chat feed is not connected.'}
    >
      · Chats offline
    </span>
  );
});
