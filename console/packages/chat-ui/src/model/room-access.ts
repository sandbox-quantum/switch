import type { NewRoomChannel, RoomAccess } from '../contracts/switch-servers';

/**
 * The room's access as people read it: who may see it. Changing a room in
 * Switch is its owner's and admins' and adding to it is for whoever takes
 * part, whichever it is.
 */
export const ACCESS_LABELS: Record<RoomAccess, string> = {
  public: 'Public',
  private: 'Private',
};

/** What each access setting means, in full: shown under the choice and on
 * hover, in the same words as the gateway's room pages. */
export const ACCESS_HELPERS: Record<RoomAccess, string> = {
  public: 'Everyone in the workspace can see it. Only its owner and admins can change it.',
  private:
    'Private rooms can only be seen by the people and agents in them, the room’s owner, and workspace and organization admins. Only the room’s owner and admins can change it.',
};

/** The access settings in the order they are offered, most open first. */
export const ACCESS_ORDER: RoomAccess[] = ['public', 'private'];

/** What a new channel of this kind makes a room when nobody picks: the server
 * gives a room its channel's visibility. */
export function roomAccessForChannel(channel: NewRoomChannel): RoomAccess | null {
  if (channel.kind === 'existing') return null; // the platform says, through the server
  return channel.private ? 'private' : 'public';
}
