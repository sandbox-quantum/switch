import { observable, runInAction } from 'mobx';
import { events, rpc } from '@renderer/lib/ipc';
import type { ServerFeatureFlags } from '@shared/core/feature-flags/feature-flags';
import { featureFlagsChangedChannel } from '@shared/events/featureFlagEvents';

const known = observable.map<string, boolean>();
const asked = new Set<string>();

function record(state: ServerFeatureFlags): void {
  if (state.fetchedAt === null) return;
  runInAction(() => known.set(state.serverId, state.flags.agent_chats));
}

events.on(featureFlagsChangedChannel, record);

const RETRY_MS = 15_000;

/** Read the server's flags, now if never read, and again until a read succeeds. */
function ask(serverId: string): void {
  void rpc.featureFlags.current(serverId).then((res) => {
    if (!res?.success) return;
    record(res.data);
    if (res.data.fetchedAt === null && !known.has(serverId))
      setTimeout(() => ask(serverId), RETRY_MS);
  });
}

/**
 * Whether a server turns agent_chats on, observable outside React. Undefined
 * until the server's flags have been read once, which is tried again until it
 * works; a server that does not send the flag is off.
 */
export function agentChatsFlag(serverId: string): boolean | undefined {
  if (!asked.has(serverId)) {
    asked.add(serverId);
    ask(serverId);
  }
  return known.get(serverId);
}
