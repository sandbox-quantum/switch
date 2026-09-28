import { Button } from '@renderer/lib/ui/button';
import { useDiscoveryFailures } from './discovery-failure-indicator';

/**
 * Console could not ask for discovery failures at all, so no agent row can
 * show its own. Each agent's failure is on its row; this is only the case that
 * belongs to none of them.
 */
export function SessionDiscoveryStatus() {
  const query = useDiscoveryFailures();
  if (!query.error) return null;
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-foreground-warning"
    >
      <span>Couldn’t check your agents’ sessions.</span>
      <Button
        size="sm"
        variant="outline"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        Retry
      </Button>
    </div>
  );
}
