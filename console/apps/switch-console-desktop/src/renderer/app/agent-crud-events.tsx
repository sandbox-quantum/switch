import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { LOAD_AGENTS_QUERY_KEY } from '@renderer/features/remote-hosts/load-existing-agents-section';
import { events } from '@renderer/lib/ipc';
import { agentsChangedChannel } from '@shared/events/appEvents';

/**
 * React to agent CRUD from the main process (CHOO-2560): reload the sidebar's
 * agents store and refetch any open "Load existing agents" discovery, so a
 * created or removed agent is reflected everywhere without per-call-site
 * invalidation.
 */
export function AgentCrudEvents() {
  const queryClient = useQueryClient();

  useEffect(
    () =>
      events.on(agentsChangedChannel, () => {
        void agentsStore.load();
        void queryClient.invalidateQueries({ queryKey: [LOAD_AGENTS_QUERY_KEY] });
      }),
    [queryClient]
  );

  return null;
}
