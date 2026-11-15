import type { IExecutionContext } from '@main/core/execution-context/types';
import { listHostWatchers, watcherRunsBundle } from './host-watchers';
import { sharedHostBundle } from './shared-host-deployment';

/**
 * Refuses a session that is to continue a CLI conversation when the agent's
 * Room watcher on `host` says it runs another build of Switch Console's host.
 * That watcher reads the session's configuration with its own schema: an
 * older one refuses the key and could not import the history anyway. One
 * whose build cannot be told, or no watcher at all, is not refused: handing
 * the session over says what is wrong, if anything is.
 *
 * Asked before such a session's conversation is copied, and again before its
 * first start, which imports the conversation.
 */
export async function ensureWatcherCanContinueCliConversation(
  ctx: IExecutionContext,
  host: string,
  switchAgentId: string
): Promise<void> {
  const watcher = (await listHostWatchers(ctx)).get(switchAgentId);
  if (watcherRunsBundle(watcher, await sharedHostBundle()) === false)
    throw new Error(
      `The Room watcher on ${host} does not run this version of Switch Console's host, so it cannot continue a CLI conversation. Press Update on its Room watcher, then try again.`
    );
}
