import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';

function switchSetupQueryKey(agentId: string) {
  return ['switch-setup', agentId] as const;
}

/**
 * Agent types that can be onboarded into Switch right now — Switch-supported AND
 * with their connector plugin installed. Drives the onboarding agent-type picker.
 * When `sshHost` is set the availability is resolved on that remote host (over
 * SSH) rather than the local machine, so a remote agent offers the types the
 * host actually has installed.
 */
export function useOnboardableAgentTypes(sshHost?: string) {
  return useQuery({
    queryKey: ['switch-setup', 'onboardable', sshHost ?? 'local'] as const,
    queryFn: () =>
      sshHost ? rpc.switchSetup.listOnboardableRemote(sshHost) : rpc.switchSetup.listOnboardable(),
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

  const invalidate = () => void qc.invalidateQueries({ queryKey });

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
