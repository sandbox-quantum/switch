import { defineEvent } from '@shared/lib/ipc/events';

/** What changed for the signed-in user on a server, as the server pushes it. */
export type UserChange = {
  kind: 'managed_agent' | 'machine' | (string & {});
  /** Null when the notice covers every one of its kind. */
  id: string | null;
};

export type UserChangesEvent =
  /** The server's change socket is open: lists it covers no longer need polling. */
  | { serverId: string; type: 'live'; kinds: string[] }
  /** The socket closed; poll until it is open again. */
  | { serverId: string; type: 'down' }
  | { serverId: string; type: 'changed'; changes: UserChange[] };

/** Change notices from the servers Console is signed in to. */
export const userChangesChannel = defineEvent<UserChangesEvent>('user-changes:event');
