import { chatsStore } from '@renderer/features/chats/stores/chats';
import { queryClient } from '@renderer/lib/query-client';

/**
 * An agent's name or display name changed: read again what shows it in rooms
 * and chats, which nothing else refreshes until a reload — the rooms' own
 * participant lists and the chat summaries mention suggestions are read from.
 */
export function agentNamesChanged(): void {
  for (const key of ['remote-room-detail', 'chat-members', 'workspace-agents'])
    void queryClient.invalidateQueries({ queryKey: [key] });
  void chatsStore.refreshSummaries();
}
