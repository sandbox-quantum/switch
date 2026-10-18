import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';

/**
 * This computer as a machine of the workspace, for the buddy to run on.
 *
 * `starting`: being enrolled, or enrolled and not yet reported to Switch.
 * `failed`: it could not be set up; `error` says why, and nothing pretends
 * the providers are known.
 */
export type ThisComputer =
  | { kind: 'starting' }
  | { kind: 'ready'; machine: OwnedMachine }
  | { kind: 'failed'; error: string };

/**
 * One setup per server at a time: the buddy pages each ask, and a second
 * enrolment started while the first runs would be refused as a duplicate.
 */
const settingUp = new Map<string, Promise<void>>();

function ensureRunsAgents(serverId: string, workspaceId: string): Promise<void> {
  const running = settingUp.get(serverId);
  if (running) return running;
  const attempt = (async () => {
    const overview = await rpc.embeddedController.getOverview({ serverId, workspaceId });
    if (overview.unsupportedReason) throw new Error(overview.unsupportedReason);
    if (overview.enrollment === null)
      await rpc.embeddedController.enable({ serverId, workspaceId });
  })().finally(() => settingUp.delete(serverId));
  settingUp.set(serverId, attempt);
  return attempt;
}

/**
 * Makes sure this computer runs managed agents for the workspace, enrolling
 * it when it does not yet, and follows what it reports.
 *
 * The buddy always runs on the person's own computer, whatever server they
 * chose, so this happens on every path, in the background, as soon as the
 * workspace is known.
 */
export function useThisComputer(serverId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  const [setupError, setSetupError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await ensureRunsAgents(serverId, workspaceId);
        await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY, serverId] });
      } catch (cause) {
        if (!cancelled)
          setSetupError(failureText(cause, 'Could not set this computer up to run agents.'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, workspaceId, queryClient]);

  const machines = useQuery({
    queryKey: [MANAGED_AGENTS_KEY, serverId, 'machines', workspaceId],
    queryFn: () => rpc.managedAgents.machines(serverId),
    // Quick while this computer has not reported yet, then at an easy pace.
    refetchInterval: (query) =>
      query.state.data?.some((m) => m.local?.kind === 'this-computer' && m.providers.length > 0)
        ? 10_000
        : 2_000,
  });

  /**
   * Has this computer check every provider again now and reads the result;
   * resolves to a line saying when the check found nothing ready that was not
   * before, or null when something changed.
   */
  const recheck = useCallback(async (): Promise<string | null> => {
    const before = readyOn(machines.data);
    await rpc.embeddedController.recheckProviders(serverId);
    const after = readyOn((await machines.refetch()).data);
    return after > before
      ? null
      : 'Checked just now: nothing new is signed in yet. Finish signing in, then check again.';
  }, [serverId, machines]);

  const machine = machines.data?.find((m) => m.local?.kind === 'this-computer') ?? null;
  const state: ThisComputer = setupError
    ? { kind: 'failed', error: setupError }
    : machines.data === null
      ? {
          kind: 'failed',
          error: 'This server does not run managed agents, so switch-buddy cannot be set up here.',
        }
      : machine && machine.providers.length > 0
        ? { kind: 'ready', machine }
        : { kind: 'starting' };
  return { state, recheck };
}

/** How many providers this computer last reported ready. */
function readyOn(machines: OwnedMachine[] | null | undefined): number {
  const machine = machines?.find((m) => m.local?.kind === 'this-computer');
  return machine?.providers.filter((provider) => provider.ready).length ?? 0;
}
