import { useMutation, useQuery } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { SidebarItemMiniButton } from './sidebar-primitives';

/** Every agent's discovery failure, polled once and shared by all the rows that ask. */
export function useDiscoveryFailures() {
  return useQuery({
    queryKey: ['sdk-discovery-errors'],
    queryFn: () => rpc.sdkHost.discoveryErrors(),
    refetchInterval: 3000,
  });
}

/**
 * A warning on an agent whose sessions could not be read from its host, which
 * retries when clicked. A host that is down is not reported here: the host's
 * own indicator on the same row already says so.
 */
export function DiscoveryFailureIndicator({ agentId, label }: { agentId: string; label: string }) {
  const { toast } = useToast();
  const query = useDiscoveryFailures();
  const retry = useMutation({
    mutationFn: () => rpc.sdkHost.retryDiscovery(agentId),
    onSettled: () => query.refetch(),
    onError: (error) => {
      const { headline, detail } = describeFailure(
        error,
        `Could not retry loading ${label}'s sessions.`
      );
      toast({ title: headline, description: detail ?? undefined, variant: 'destructive' });
    },
  });
  const failure = query.data?.find((entry) => entry.agentId === agentId);
  if (!failure) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarItemMiniButton
            type="button"
            aria-label={`Could not load sessions for ${label}. Retry`}
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
        <p>Couldn’t load this agent’s sessions — click to retry.</p>
        <p className="mt-1 text-foreground-muted">{failure.message}</p>
      </TooltipContent>
    </Tooltip>
  );
}
