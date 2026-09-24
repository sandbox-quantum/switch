import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { updateCheckUnavailable } from '@shared/core/switch-setup/update-check';

function switchSetupQueryKey(agentId: string) {
  return ['switch-setup', agentId] as const;
}

/** Deliberately not under `switchSetupQueryKey`: this answers for every agent
 *  type at once, so it belongs to no single one of them. */
function agentTypeAvailabilityQueryKey(sshHost: string | undefined) {
  return ['switch-setup', 'agent-type-availability', sshHost ?? 'local'] as const;
}

/**
 * Every Switch-capable agent type, each carrying whether it can be onboarded
 * here and — when it cannot — why. Drives the onboarding agent-type picker,
 * which shows the whole roster and greys out what is not set up rather than
 * hiding it (CHOO-1809).
 *
 * When `sshHost` is set, availability is resolved on that remote host over SSH
 * rather than on this machine: a type installed locally and absent on the host
 * being targeted is not available *there*, which is the question being asked.
 */
export function useAgentTypeAvailability(sshHost?: string) {
  return useQuery({
    queryKey: agentTypeAvailabilityQueryKey(sshHost),
    queryFn: () =>
      sshHost
        ? rpc.switchSetup.listAgentTypeAvailabilityRemote(sshHost)
        : rpc.switchSetup.listAgentTypeAvailability(),
    staleTime: 30_000,
  });
}

/**
 * Drives the Switch connector plugin lifecycle for one agent type.
 * Installed status loads fast and locally; the marketplace-backed update check
 * runs only when checkForUpdates is invoked. Mutations invalidate the status query.
 */
export function useSwitchSetup(agentId: string) {
  const qc = useQueryClient();
  const queryKey = switchSetupQueryKey(agentId);

  const query = useQuery({
    queryKey,
    queryFn: () => rpc.switchSetup.getStatus(agentId),
    staleTime: 30_000,
  });

  /**
   * Installing or removing a connector changes two answers: this agent type's
   * own status, and the roster of types that can be onboarded at all.
   *
   * The roster is cached under its own key, so the per-agent invalidation did
   * not reach it. The onboarding checklist reads the roster to decide whether
   * the agent-providers step is done — and it locks every later step behind the
   * first unfinished one. Installing a connector therefore left the step
   * unticked and the rest of onboarding greyed out until something else
   * happened to refetch.
   */
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey });
    void qc.invalidateQueries({ queryKey: ['switch-setup', 'agent-type-availability'] });
  };

  const checkForUpdates = useMutation({
    mutationFn: () => rpc.switchSetup.checkForUpdates(agentId),
    onSuccess: (status) => {
      qc.setQueryData(queryKey, status);
      if (status.refreshError) {
        toast({
          title: 'Could not refresh the plugin marketplace — showing cached status',
          description: status.refreshError,
          variant: 'destructive',
        });
      } else if (updateCheckUnavailable(status)) {
        // No advertised version to compare against, so the refresh proved
        // nothing. Saying "up to date" here would assert what was not checked.
        toast({
          title: 'Could not determine whether an update exists',
          description: 'This agent type does not report plugin versions on a remote host.',
        });
      } else if (status.supported && status.installed && !status.updateAvailable) {
        toast({ title: 'Switch connector is up to date' });
      }
    },
    onError: () => toast({ title: 'Could not check for updates', variant: 'destructive' }),
  });

  const install = useMutation({
    mutationFn: () => rpc.switchSetup.install(agentId),
    onSuccess: (r) =>
      toast(
        r.success
          ? { title: 'Switch connector installed' }
          : { title: r.message ?? 'Install failed', variant: 'destructive' }
      ),
    onError: () => toast({ title: 'Install failed', variant: 'destructive' }),
    onSettled: invalidate,
  });

  const update = useMutation({
    mutationFn: () => rpc.switchSetup.update(agentId),
    onSuccess: (r) =>
      toast(
        r.success
          ? { title: 'Switch connector updated' }
          : { title: r.message ?? 'Update failed', variant: 'destructive' }
      ),
    onError: () => toast({ title: 'Update failed', variant: 'destructive' }),
    onSettled: invalidate,
  });

  const uninstall = useMutation({
    mutationFn: () => rpc.switchSetup.uninstall(agentId),
    onSuccess: (r) =>
      toast(
        r.success
          ? { title: 'Switch connector removed' }
          : { title: r.message ?? 'Uninstall failed', variant: 'destructive' }
      ),
    onError: () => toast({ title: 'Uninstall failed', variant: 'destructive' }),
    onSettled: invalidate,
  });

  return {
    status: query.data,
    isLoading: query.isLoading,
    checkForUpdates: checkForUpdates.mutate,
    isChecking: checkForUpdates.isPending,
    install: install.mutate,
    isInstalling: install.isPending,
    update: update.mutate,
    isUpdating: update.isPending,
    uninstall: uninstall.mutate,
    isUninstalling: uninstall.isPending,
  };
}
