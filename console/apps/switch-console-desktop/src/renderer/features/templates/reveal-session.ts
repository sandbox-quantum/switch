import { findSessionForRoom } from '@renderer/features/switch-rooms/session-deeplink-listener';
import { appState } from '@renderer/lib/stores/app-state';

/**
 * Once a kickoff addresses a new agent, the Console starts a session for it
 * in the room. That session is the thing worth watching, so when it appears
 * while the person is still looking at the room, open it. Gives up quietly
 * after a while: no session means no kickoff, and the toast already said so.
 */
export async function revealSessionWhenItStarts(roomId: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const stillOnRoom =
      appState.navigation.currentViewId === 'room' &&
      (appState.navigation.viewParamsStore.room as { roomId?: string } | undefined)?.roomId ===
        roomId;
    if (!stillOnRoom) return;
    const found = findSessionForRoom(roomId);
    if (found) {
      appState.navigation.navigate('session', found);
      return;
    }
  }
}
