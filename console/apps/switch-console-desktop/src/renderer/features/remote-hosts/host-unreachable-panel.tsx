import { PlugZap, RefreshCw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Button } from '@renderer/lib/ui/button';
import type { HostReachability } from '@shared/core/remote-hosts/reachability';
import { hostReachabilityStore } from './host-reachability-store';

function relativeToNow(iso: string | null): string | null {
  if (!iso) return null;
  const deltaMs = new Date(iso).getTime() - Date.now();
  const seconds = Math.round(Math.abs(deltaMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

/**
 * The single "this host is down" surface (CHOO-1682). Replaces the raw ssh2
 * message ("Connection lost before handshake") that used to reach the user with
 * the modeled state: what is wrong, that work is paused rather than silently
 * retrying forever, when the next automatic probe lands, and one button to
 * retry now.
 */
export const HostUnreachablePanel = observer(function HostUnreachablePanel({
  reachability,
}: {
  reachability: HostReachability;
}) {
  const { sshHost, status, lastError, nextProbeAt, lastReachableAt } = reachability;
  const retrying = hostReachabilityStore.isRetrying(sshHost) || reachability.probing;
  const nextProbe = relativeToNow(nextProbeAt);
  const lastSeen = relativeToNow(lastReachableAt);
  const suspended = status === 'suspended';

  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-lg border border-amber-500/25 bg-amber-500/5 px-6 py-7 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-amber-500/12">
          <PlugZap className="size-5 text-amber-500" />
        </div>

        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium text-foreground">
            {suspended ? 'SSH authentication failed' : 'Host unreachable'}
          </p>
          <p className="font-mono text-xs text-foreground-muted">{sshHost}</p>
        </div>

        {lastError && (
          <p className="max-w-sm text-xs break-words text-foreground-muted">{lastError}</p>
        )}

        <p className="max-w-sm text-xs text-foreground-passive">
          {suspended
            ? 'Automatic retries are paused — a rejected credential will not fix itself. Restore SSH access to this host, then retry.'
            : 'Work on this host is paused so it is not retried continuously. It resumes automatically once the host is back.'}
        </p>

        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={retrying}
          onClick={() => void hostReachabilityStore.retry(sshHost)}
        >
          <RefreshCw className={retrying ? 'size-3.5 animate-spin' : 'size-3.5'} />
          {retrying ? 'Checking…' : 'Retry connection'}
        </Button>

        {(nextProbe || lastSeen) && (
          <div className="flex items-center gap-2 text-[11px] text-foreground-passive">
            {!suspended && nextProbe && <span>Next check in {nextProbe}</span>}
            {!suspended && nextProbe && lastSeen && <span aria-hidden>·</span>}
            {lastSeen && <span>Last reachable {lastSeen} ago</span>}
          </div>
        )}
      </div>
    </div>
  );
});
