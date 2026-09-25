import { defineEvent } from '@shared/lib/ipc/events';

/**
 * The set of workspaces this install holds changed in the main process.
 *
 * Fired by the reconcile, which is the one thing that adds, matches and drops
 * workspace rows without a window having asked for it — the boot sweep, and
 * every sign-in. Without it a membership added or withdrawn since the last
 * launch stays invisible for the whole session, and a placeholder the sweep
 * deleted goes on being offered in the switcher by a renderer holding the list
 * it read at startup.
 */
export const workspacesChangedChannel = defineEvent<void>('workspaces:changed');
