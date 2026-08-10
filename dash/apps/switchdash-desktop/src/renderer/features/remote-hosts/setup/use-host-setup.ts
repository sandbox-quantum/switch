/**
 * Renderer access to a host's setup plan (CHOO-1809).
 *
 * The plan is **pushed**, not polled. The old page re-probed the host on every
 * mount — an SSH round trip per row, fired during render — which is what made
 * opening the page so expensive and so noisy. Here the main process owns the
 * plan and emits it on every transition; this hook just mirrors it.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { hostSetupPlanEventChannel, type HostSetupPlan } from '@shared/core/remote-hosts/setup';

export function setupPlanQueryKey(sshHost: string) {
  return ['remote-host-setup-plan', sshHost];
}

/** Live plan for one host, kept current by pushed events. */
export function useHostSetupPlan(sshHost: string) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: setupPlanQueryKey(sshHost),
    queryFn: () => rpc.remoteHosts.getSetupPlan(sshHost),
  });

  useEffect(() => {
    return events.on(hostSetupPlanEventChannel, (plan) => {
      if (plan.sshHost !== sshHost) return;
      queryClient.setQueryData(setupPlanQueryKey(sshHost), plan);
    });
  }, [sshHost, queryClient]);

  return query;
}

/** Every host's plan at once, for the list page. Also kept current by events. */
export function useAllHostSetupPlans(sshHosts: string[]) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['remote-host-setup-plans', [...sshHosts].sort().join(',')],
    queryFn: async () => {
      const plans = await Promise.all(
        sshHosts.map((sshHost) => rpc.remoteHosts.getSetupPlan(sshHost))
      );
      return Object.fromEntries(
        plans
          .filter((plan): plan is HostSetupPlan => plan !== null)
          .map((plan) => [plan.sshHost, plan])
      );
    },
    enabled: sshHosts.length > 0,
  });

  useEffect(() => {
    return events.on(hostSetupPlanEventChannel, (plan) => {
      queryClient.setQueryData(
        ['remote-host-setup-plans', [...sshHosts].sort().join(',')],
        (prev: Record<string, HostSetupPlan> | undefined) => ({ ...prev, [plan.sshHost]: plan })
      );
    });
  }, [sshHosts, queryClient]);

  return query;
}

/** Build or refresh the plan without running it — what the host page does on open. */
export function usePrepareSetup(sshHost: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => rpc.remoteHosts.prepareSetup(sshHost),
    onSuccess: (plan) => queryClient.setQueryData(setupPlanQueryKey(sshHost), plan),
    onError: (error) => log.error('Could not prepare remote host setup', { sshHost, error }),
  });
}

/**
 * Probe every step without installing anything. `prepareSetup` only rebuilds
 * the list of steps — this is the one that actually looks at the host.
 */
export function useRecheckSetup(sshHost: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => rpc.remoteHosts.recheckSetup(sshHost),
    onSuccess: (plan) => queryClient.setQueryData(setupPlanQueryKey(sshHost), plan),
    onError: (error) => log.error('Could not re-check remote host', { sshHost, error }),
  });
}

/**
 * Re-observe one step on its own — the per-row re-check button.
 *
 * Whole-host re-check costs an SSH round trip per step, which is a lot to pay
 * to answer "is this one still installed?".
 */
export function useRecheckSetupStep(sshHost: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (stepId: string) => rpc.remoteHosts.recheckSetupStep({ sshHost, stepId }),
    onSuccess: (plan) => queryClient.setQueryData(setupPlanQueryKey(sshHost), plan),
    onError: (error) => log.error('Could not re-check a setup step', { sshHost, error }),
  });
}

/** Install one step on its own — the per-row Install button. */
export function useInstallSetupStep(sshHost: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (stepId: string) => rpc.remoteHosts.installSetupStep({ sshHost, stepId }),
    onSuccess: (plan) => queryClient.setQueryData(setupPlanQueryKey(sshHost), plan),
    onError: (error) => log.error('Could not install a setup step', { sshHost, error }),
  });
}

/** Replace one step with its newest version — the per-row Update button. */
export function useUpdateSetupStep(sshHost: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (stepId: string) => rpc.remoteHosts.updateSetupStep({ sshHost, stepId }),
    onSuccess: (plan) => queryClient.setQueryData(setupPlanQueryKey(sshHost), plan),
    onError: (error) => log.error('Could not update a setup step', { sshHost, error }),
  });
}

export function useSkipSetupStep(sshHost: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (stepId: string) => rpc.remoteHosts.skipSetupStep({ sshHost, stepId }),
    onSuccess: (plan) => queryClient.setQueryData(setupPlanQueryKey(sshHost), plan),
    onError: (error) => log.error('Could not skip a setup step', { sshHost, error }),
  });
}
