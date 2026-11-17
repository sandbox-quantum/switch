import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';

/**
 * This computer as a machine of the workspace, for the buddy to run on.
 *
 * `off`: it does not run managed agents for the workspace, and stays so
 * until the person turns it on (`turnOn`, from `useThisComputer`, after they
 * confirm). `starting`: being enrolled, or enrolled and not yet reported to
 * Switch. `failed`: it could not be set up, or its machines could not be
 * read; `error` says why, and nothing pretends the providers are known.
 * `retry` tries again.
 */
export type ThisComputer =
  | { kind: 'off' }
  | { kind: 'starting' }
  | { kind: 'ready'; machine: OwnedMachine }
  | { kind: 'failed'; error: string };

/**
 * One setup per server at a time: a second enrolment started while the first
 * runs would be refused as a duplicate.
 */
const settingUp = new Map<string, Promise<void>>();

function turnOnThisComputer(serverId: string, workspaceId: string): Promise<void> {
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
 * Whether this computer runs managed agents for the workspace, and what it
 * reports once it does.
 *
 * The buddy always runs on the person's own computer, but this never turns
 * it on by itself: the pages that use it open from links too, and making the
 * computer a machine lets the server run agents on it. `turnOn` does, once
 * the person has confirmed.
 */
export function useThisComputer(serverId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  const [setupError, setSetupError] = useState<string | null>(null);
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  // Bumped by `retry`, to read this computer again after a failure.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSetupError(null);
    void (async () => {
      try {
        const overview = await rpc.embeddedController.getOverview({ serverId, workspaceId });
        if (overview.unsupportedReason) throw new Error(overview.unsupportedReason);
        if (!cancelled) setEnrolled(overview.enrollment !== null);
      } catch (cause) {
        if (!cancelled)
          setSetupError(failureText(cause, 'Could not check whether this computer runs agents.'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, workspaceId, attempt]);

  const turnOn = useCallback(async () => {
    setSetupError(null);
    setEnrolled(true);
    try {
      await turnOnThisComputer(serverId, workspaceId);
      await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY, serverId] });
    } catch (cause) {
      setSetupError(failureText(cause, 'Could not set this computer up to run agents.'));
    }
  }, [serverId, workspaceId, queryClient]);

  const machines = useQuery({
    queryKey: [MANAGED_AGENTS_KEY, serverId, 'machines', workspaceId],
    queryFn: () => rpc.managedAgents.machines(serverId),
    // Quick while this computer has not reported yet, then at an easy pace.
    refetchInterval: (query) =>
      (thisComputerIn(query.state.data)?.providers.length ?? 0) > 0 ? 10_000 : 2_000,
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

  const machine = thisComputerIn(machines.data);
  const reported = machine !== null && machine.providers.length > 0;

  // Console's own check of the providers, made as onboarding opened: what
  // the page goes by until this computer's controller reports.
  const early = useQuery({
    queryKey: ['provider-precheck'],
    queryFn: () => rpc.embeddedController.precheckedProviders(),
    enabled: !reported,
    refetchInterval: 1_000,
  });
  // Machines that could not be read at all (the server unreachable, the
  // session gone) are a failure to say, not a spinner that never ends; a
  // read that fails after one worked keeps what it last had.
  const readError =
    machines.data === undefined && machines.error
      ? failureText(machines.error, 'Could not reach Switch to check this computer.')
      : null;
  const state = thisComputerState(setupError ?? readError, enrolled, machines.data);
  const earlyProviders = !reported && early.data && early.data.length > 0 ? early.data : null;
  const { refetch } = machines;
  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
    void refetch();
  }, [refetch]);
  return { state, recheck, earlyProviders, retry, turnOn };
}

/**
 * Where this computer stands, from why setting it up failed (null when it
 * did not), whether it is enrolled (null until known) and the workspace's
 * machines as last read: null when the server runs no managed agents,
 * undefined before the first read. Ready once this computer is among them
 * and has reported its providers, even if setting it up said it failed: a
 * setup that timed out may still have worked, and the report is what Switch
 * checks.
 */
export function thisComputerState(
  setupError: string | null,
  enrolled: boolean | null,
  machines: OwnedMachine[] | null | undefined
): ThisComputer {
  const machine = thisComputerIn(machines);
  if (machine && machine.providers.length > 0) return { kind: 'ready', machine };
  if (setupError) return { kind: 'failed', error: setupError };
  if (machines === null)
    return {
      kind: 'failed',
      error: 'This server does not run managed agents, so switch-buddy cannot be set up here.',
    };
  if (enrolled === false && machine === null) return { kind: 'off' };
  return { kind: 'starting' };
}

/** How many providers this computer last reported ready. */
function readyOn(machines: OwnedMachine[] | null | undefined): number {
  const machine = thisComputerIn(machines);
  return machine?.providers.filter((provider) => provider.ready).length ?? 0;
}

/** This computer among the workspace's machines, once it is one. */
export function thisComputerIn(machines: OwnedMachine[] | null | undefined): OwnedMachine | null {
  return machines?.find((m) => m.local?.kind === 'this-computer') ?? null;
}
