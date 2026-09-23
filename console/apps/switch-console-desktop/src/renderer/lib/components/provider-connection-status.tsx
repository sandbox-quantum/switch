import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, CheckCircle2, CircleAlert, Copy, Loader2, RefreshCw } from 'lucide-react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { getProvider, type AgentProviderId } from '@shared/core/providers/agent-provider-registry';

const loginCommands: Record<AgentProviderId, string> = {
  claude: 'claude auth login',
  codex: 'codex login',
  cursor: 'agent login',
  antigravity: 'antigravity-acp --login',
  opencode: 'opencode auth login',
};

export function ProviderConnectionStatus({
  providerId,
  sshHost,
  dir,
  compact = false,
}: {
  providerId: AgentProviderId;
  sshHost: string | null;
  dir: string;
  compact?: boolean;
}) {
  const query = useQuery({
    queryKey: ['provider-readiness', providerId, sshHost, dir],
    queryFn: () => rpc.agents.providerReadiness({ providerId, sshHost, dir }),
    // Signing in is not something that changes minute to minute, and this
    // component is rendered once per provider tile and once per agent row —
    // so a short window turned opening a page into a burst of probes, each of
    // which starts a provider process on the execution machine.
    staleTime: 5 * 60_000,
    retry: false,
  });
  const copy = useMutation({
    mutationFn: () => navigator.clipboard.writeText(loginCommands[providerId]),
  });
  const data = query.data;
  const checking = query.isFetching;
  const missing = data?.installed === false;
  const ready = data?.installed === true && data.status === 'authenticated';
  const headline = checking
    ? 'Checking installation and sign-in…'
    : data?.installed == null
      ? 'Could not check CLI'
      : missing
        ? 'CLI not installed'
        : data?.status === 'unauthenticated'
          ? 'Not signed in'
          : data?.status === 'unconfigured'
            ? 'No backend configured'
            : ready
              ? providerId === 'opencode'
                ? 'Backend connected'
                : 'Signed in'
              : 'Sign-in not verified';
  const Icon = checking ? Loader2 : ready ? CheckCircle2 : CircleAlert;
  const tone = checking || ready ? 'text-foreground-muted' : 'text-foreground-warning';
  if (compact)
    return (
      <span className={`inline-flex items-center gap-1.5 text-xs ${tone}`}>
        <Icon className={`size-3.5 ${checking ? 'animate-spin' : ''}`} />
        {headline}
      </span>
    );
  return (
    <div className="rounded-lg border border-border bg-background-1 p-3 text-sm" role="status">
      <div className="flex items-center gap-2">
        <Icon className={`size-4 shrink-0 ${tone} ${checking ? 'animate-spin' : ''}`} />
        <span className="font-medium">
          {getProvider(providerId)?.name} · {headline}
        </span>
        <Button
          className="ml-auto shrink-0"
          size="sm"
          variant="ghost"
          disabled={checking}
          onClick={() => void query.refetch()}
          aria-label="Recheck installation and sign-in"
        >
          <RefreshCw className={`size-3.5 ${checking ? 'animate-spin' : ''}`} />
          Recheck
        </Button>
      </div>
      <p className="mt-1 text-xs text-foreground-muted">
        {sshHost ? `On ${sshHost}` : 'On this computer'}
        {data?.installed === true ? ' · CLI installed' : ''}
      </p>
      {!checking && !ready && (
        <p className="mt-2 text-foreground-muted">
          {query.error
            ? 'Could not reach this host. Check the connection and try again.'
            : data?.status === 'unauthenticated'
              ? 'Sign in to use this provider.'
              : data?.message}
        </p>
      )}
      {!checking && data?.installed && !ready && (
        <div className="mt-2 space-y-1">
          <p>Run in a terminal {sshHost ? `on ${sshHost}` : 'on this computer'}, then Recheck:</p>
          <div className="flex items-center gap-2 rounded bg-background px-2 py-1">
            <code className="min-w-0 flex-1 text-xs break-all select-all">
              {loginCommands[providerId]}
            </code>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => copy.mutate()}
              aria-label="Copy sign-in command"
            >
              {copy.isSuccess ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copy.isSuccess ? 'Copied' : 'Copy'}
            </Button>
          </div>
          {copy.error && (
            <p role="alert">Could not copy. Select the command above to copy it manually.</p>
          )}
        </div>
      )}
      {!checking && missing && (
        <p className="mt-2 text-foreground-muted">
          Install this CLI {sshHost ? 'from this host’s setup page' : 'in Settings → Agents'}, then
          recheck.
        </p>
      )}
    </div>
  );
}
