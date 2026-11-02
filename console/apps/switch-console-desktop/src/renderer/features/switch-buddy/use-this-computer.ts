import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useCloudMachines } from '@renderer/features/cloud-agents/use-cloud-agents';
import {
  boxBackends,
  hasSharedCloudBox,
} from '@renderer/features/locations/components/add-agent-modal/server-run-locations';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { events, rpc } from '@renderer/lib/ipc';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import { featureFlagsChangedChannel } from '@shared/events/featureFlagEvents';
import {
  FLAGS_NOT_SIGNED_IN,
  flagsAnswered,
  openingSetup,
  setUpThisComputer,
  type ThisComputerSetup,
} from './this-computer-setup';

/**
 * This computer as a machine of the workspace, for the buddy to run on.
 *
 * `needs-permission`: not a machine of the workspace, and not made one until
 * the person says so (B38).
 * `starting`: being enrolled, or enrolled and not yet reported to Switch.
 * `failed`: it could not be set up; `error` says why, and nothing pretends
 * the providers are known.
 */
export type ThisComputer =
  | { kind: 'needs-permission' }
  | { kind: 'starting' }
  | { kind: 'ready'; machine: OwnedMachine }
  | { kind: 'failed'; error: string };

/**
 * One enrolment per server at a time: the buddy pages each ask, and a second
 * enrolment started while the first runs would be refused as a duplicate.
 */
const enrolling = new Map<string, Promise<ThisComputerSetup>>();

function setUp(serverId: string, workspaceId: string, allowEnrol: boolean) {
  const running = enrolling.get(serverId);
  if (running) return running;
  const attempt = setUpThisComputer(rpc.embeddedController, serverId, workspaceId, allowEnrol);
  if (!allowEnrol) return attempt;
  enrolling.set(serverId, attempt);
  return attempt.finally(() => enrolling.delete(serverId));
}

/**
 * Whether this computer runs managed agents for the workspace, and what it
 * reports once it does.
 *
 * The buddy always runs on the person's own computer, whatever server they
 * chose. With hosted agents v2 on (`hosted_v2`), opening a page only reads: a
 * computer that is not yet a machine of the workspace is made one by `allow`,
 * when the person chooses to (B38). With it off, it is enrolled as soon as the
 * workspace is known, exactly as upstream does. Nothing happens until the
 * server's flags are known, so a v2 server never enrols on a first guess.
 */
export function useThisComputer(serverId: string, workspaceId: string) {
  // The shared-cloud wording only where Core says hosted agents v2 is on, on a box it names.
  const hostedV2 = useFeatureFlags(serverId).hosted_v2;
  const flagsKnown = useFlagsAnswered(serverId);
  const cloudMachines = useCloudMachines(hostedV2 ? serverId : null);
  const queryClient = useQueryClient();
  const [setupError, setSetupError] = useState<string | null>(null);
  /** Null until the first read comes back. */
  const [setup, setSetup] = useState<ThisComputerSetup | null>(null);

  useEffect(() => {
    // B38 (ask first) only with hosted agents v2 on; off, enrol straight away, as upstream.
    const opening = openingSetup(flagsKnown, hostedV2);
    if (opening === 'wait') return;
    let cancelled = false;
    void (async () => {
      try {
        const found = await setUp(serverId, workspaceId, opening === 'enrol');
        if (cancelled) return;
        setSetup(found);
        if (found === 'enrolled' && opening === 'enrol')
          await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY, serverId] });
        // Not enrolled: Console's own look at the providers, so the page can
        // say what is signed in without enrolling anything.
        if (found === 'needs-permission') void rpc.embeddedController.precheckProviders();
      } catch (cause) {
        if (!cancelled)
          setSetupError(failureText(cause, 'Could not set this computer up to run agents.'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, workspaceId, flagsKnown, hostedV2, queryClient]);

  /**
   * The person's yes: makes this computer a machine of the workspace. When it
   * fails it throws, and the computer stays as it was, still to be asked: the
   * page says why and offers it again (or Not now).
   */
  const allow = useCallback(async (): Promise<void> => {
    setSetup(await setUp(serverId, workspaceId, true));
    await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY, serverId] });
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
  // Asked, not yet allowed, comes first after a failure; otherwise upstream's
  // `thisComputerState` decides (failed, ready or starting).
  const state: ThisComputer =
    !setupError && setup === 'needs-permission'
      ? { kind: 'needs-permission' }
      : thisComputerState(setupError, machines.data);
  const earlyProviders = !reported && early.data && early.data.length > 0 ? early.data : null;
  /** The person's agents run on a shared-cloud box: what the ask says about the rest. */
  const sharedCloud = hasSharedCloudBox(machines.data, hostedV2, boxBackends(cloudMachines.data));
  return { state, recheck, earlyProviders, allow, sharedCloud };
}

/**
 * Where this computer stands, from why setting it up failed (null when it
 * did not) and the workspace's machines as last read: null when the server
 * runs no managed agents, undefined before the first read. Ready once this
 * computer is among them and has reported its providers.
 */
export function thisComputerState(
  setupError: string | null,
  machines: OwnedMachine[] | null | undefined
): ThisComputer {
  if (setupError) return { kind: 'failed', error: setupError };
  if (machines === null)
    return {
      kind: 'failed',
      error: 'This server does not run managed agents, so switch-buddy cannot be set up here.',
    };
  const machine = thisComputerIn(machines);
  return machine && machine.providers.length > 0
    ? { kind: 'ready', machine }
    : { kind: 'starting' };
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

/**
 * Whether the server's flags have answered (`flagsAnswered`), kept current: a
 * read refused before sign-in waits for the read after it, so the buddy never
 * enrols a v2 server's computer on that first refusal (B38).
 */
function useFlagsAnswered(serverId: string): boolean {
  const [answered, setAnswered] = useState(false);
  useEffect(() => {
    setAnswered(false);
    let current = true;
    const off = events.on(featureFlagsChangedChannel, (state) => {
      if (state.serverId === serverId) setAnswered(flagsAnswered(state));
    });
    void rpc.featureFlags.get(serverId).then((res) => {
      if (!current || !res?.success) return;
      setAnswered((now) => now || flagsAnswered(res.data));
      // Last read refused for want of a sign-in: read again now that this page is open
      // (signed in), rather than wait for the next poll. The change event answers.
      if (res.data.error === FLAGS_NOT_SIGNED_IN) void rpc.featureFlags.refresh();
    });
    return () => {
      current = false;
      off();
    };
  }, [serverId]);
  return answered;
}
