import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  MANAGED_AGENTS_KEY,
  useManagedAgents,
  useOwnedMachines,
} from '@renderer/features/managed-agents/use-managed-agents';
import { findBuddy } from '@renderer/features/switch-buddy/buddy-identity';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';

/** How long Home waits on the check before treating AI as not connected. */
const AI_CHECK_TIMEOUT_MS = 8_000;

export type AiConnection = {
  /** Null while being checked. */
  connected: boolean | null;
  /** The person's switch-buddy, once the check has found one. */
  buddy: ManagedAgentView | null;
};

/**
 * Whether switch-buddy can chat: it exists, and the machine it runs on has an
 * AI provider installed and signed in, as that machine last reported to
 * Switch — what the buddy's setup goes by.
 *
 * Read afresh each time Home mounts, and for each workspace: what is cached
 * from before does not count, so the page never answers from an old list and
 * then changes its mind. A check that fails or does not finish in time is
 * "not connected", which offers the setup; that setup finds an existing buddy
 * rather than making a second one.
 *
 * Only reads. The setup flow is what enrols this computer to run agents; Home
 * must not do that just by being looked at.
 */
export function useAiConnected(
  serverId: string,
  workspaceId: string | null,
  /** Whether the server can be asked: signed in and answering. The check starts over when it can. */
  active: boolean
): AiConnection {
  const queryClient = useQueryClient();
  const managed = useManagedAgents(serverId);
  const machines = useOwnedMachines(serverId);
  const [since, setSince] = useState(() => Date.now());
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    setSince(Date.now());
    setTimedOut(false);
    if (!active) return;
    // The prefix covers the machines list too (`[key, serverId, 'machines', …]`),
    // so both reads are fresh after this.
    void queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY, serverId] });
    const timer = setTimeout(() => setTimedOut(true), AI_CHECK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [queryClient, serverId, workspaceId, active]);

  const fresh = (query: { dataUpdatedAt: number; errorUpdatedAt: number; isError: boolean }) =>
    query.isError ? query.errorUpdatedAt >= since : query.dataUpdatedAt >= since;

  const answer = ((): AiConnection => {
    if (!fresh(managed)) return { connected: null, buddy: null };
    const buddy = managed.isError ? null : findBuddy(managed.data ?? []);
    if (!buddy?.machine) return { connected: false, buddy };
    if (!fresh(machines)) return { connected: null, buddy };
    const machine = machines.isError
      ? undefined
      : machines.data?.find((each) => each.id === buddy.machine?.id);
    return { connected: machine?.providers.some((provider) => provider.ready) ?? false, buddy };
  })();

  if (answer.connected === null && timedOut) return { connected: false, buddy: answer.buddy };
  return answer;
}
