import { useMutation, useQuery } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { SidebarItemMiniButton } from './sidebar-primitives';

/** Why the agents the automatic move to managed could not move did not, polled once and shared. */
function useMigrationProblems() {
  return useQuery({
    queryKey: ['agent-migration-problems'],
    queryFn: () => rpc.agentMigration.getProblems(),
    refetchInterval: 5000,
  });
}

/**
 * A warning on an agent Console could not move to managed, which tries again
 * when clicked. Nothing shows while moves go through: it is only something to
 * look at when one did not.
 */
export function MigrationProblemIndicator({ agentId, label }: { agentId: string; label: string }) {
  const { toast } = useToast();
  const query = useMigrationProblems();
  const retry = useMutation({
    mutationFn: () => rpc.agentMigration.retry(agentId),
    onSettled: () => query.refetch(),
    onError: (error) => {
      const { headline, detail } = describeFailure(error, `Could not move ${label} again.`);
      toast({ title: headline, description: detail ?? undefined, variant: 'destructive' });
    },
  });
  const problem = query.data?.find((entry) => entry.agentId === agentId);
  if (!problem) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarItemMiniButton
            type="button"
            aria-label={`Could not move ${label} to a managed machine. Retry`}
            disabled={retry.isPending}
            onClick={(event) => {
              event.stopPropagation();
              retry.mutate();
            }}
          >
            <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-foreground-warning" />
          </SidebarItemMiniButton>
        }
      />
      <TooltipContent className="max-w-xs">
        <p>
          {retry.isPending
            ? 'Moving this agent to a managed machine…'
            : `Couldn’t move this agent to a managed machine on ${problem.machine}. Click to retry.`}
        </p>
        <p className="mt-1 text-foreground-muted">{problem.message}</p>
      </TooltipContent>
    </Tooltip>
  );
}
