import { defineEvent } from '@shared/lib/ipc/events';

/** What changed for the signed-in user on a server, as the server pushes it. */
export type UserChange = {
  kind: 'managed_agent' | 'machine' | (string & {});
  /** Null when the notice covers every one of its kind. */
  id: string | null;
};

/**
 * The socket's server and the workspace its session is bound to (null: the
 * server's workspace in scope when it opened). A session is one tenant's, so
 * each workspace on a server has a socket of its own.
 */
type SocketScope = { serverId: string; workspaceId: string | null };

export type UserChangesEvent = SocketScope &
  /** The server's change socket is open: lists it covers no longer need polling. */
  (
    | { type: 'live'; kinds: string[] }
    /** The socket closed; poll until it is open again. */
    | { type: 'down' }
    | { type: 'changed'; changes: UserChange[] }
  );

/** Change notices from the servers Console is signed in to. */
export const userChangesChannel = defineEvent<UserChangesEvent>('user-changes:event');
