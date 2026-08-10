import { Loader2, PlugZap, RefreshCw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { hostReachabilityStore } from './host-reachability-store';

/**
 * Inline reachability warning for forms that target a remote host — the
 * add-agent modal above all (CHOO-1676). Validating up front means the user
 * learns the host is unreachable while they can still change it, instead of
 * creating an agent that immediately lands in a failing state.
 *
 * Renders nothing when the host is fine, so it can be dropped into a form
 * unconditionally.
 */
export const HostReachabilityNotice = observer(function HostReachabilityNotice({
  sshHost,
}: {
  sshHost: string;
}) {
  // Verify on selection rather than trusting a possibly stale record: the user
  // is about to commit to this host.
  useEffect(() => {
    void hostReachabilityStore.hydrate().then(() => {
      if (hostReachabilityStore.get(sshHost).status !== 'reachable') {
        void hostReachabilityStore.retry(sshHost);
      }
    });
  }, [sshHost]);

  const reachability = hostReachabilityStore.get(sshHost);
  const retrying = hostReachabilityStore.isRetrying(sshHost) || reachability.probing;

  if (retrying) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-background-1 px-2.5 py-2 text-xs text-foreground-muted">
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
        <span>
          Checking that <span className="font-medium text-foreground">{sshHost}</span> is reachable…
        </span>
      </div>
    );
  }

  if (!hostReachabilityStore.isBlocked(sshHost)) return null;

  return (
    <div className="flex items-start gap-2.5 rounded-md border border-amber-500/30 bg-amber-500/8 px-2.5 py-2">
      <PlugZap className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-xs font-medium text-foreground">
          {reachability.status === 'suspended'
            ? `SSH authentication to ${sshHost} failed`
            : `Can’t reach ${sshHost}`}
        </p>
        {reachability.lastError && (
          <p className="text-xs break-words text-foreground-muted">{reachability.lastError}</p>
        )}
        <p className="text-xs text-foreground-passive">
          Choose a different run location, or bring the host back and retry.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={() => void hostReachabilityStore.retry(sshHost)}
      >
        <RefreshCw className="size-3" />
        Retry
      </Button>
    </div>
  );
});
