import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, Loader2, RefreshCw } from 'lucide-react';
import { ProviderConnectionStatus } from '@renderer/lib/components/provider-connection-status';
import {
  recheckThisComputer,
  useThisComputerReport,
} from '@renderer/lib/stores/use-this-computer-report';
import { Button } from '@renderer/lib/ui/button';
import { getProvider, type AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { reportedHeadline, reportedProvider } from './this-computer-status';

/**
 * A provider's install and sign-in state on this computer, for Settings →
 * Agent providers. When this computer's agent controller reported it to
 * Switch, that report is shown, the same one switch-buddy and the New agent
 * form go by; otherwise Console's own check, as before.
 */
export function ThisComputerProviderStatus({
  providerId,
  compact = false,
}: {
  providerId: AgentProviderId;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const report = useThisComputerReport();
  const recheck = useMutation({ mutationFn: () => recheckThisComputer(queryClient) });
  const reported = reportedProvider(report.data, providerId);

  // Neither check is shown until it is known whether there is a report, so
  // the line does not flip from one answer to the other.
  if (report.isPending) return <Checking compact={compact} />;
  if (!reported)
    return (
      <ProviderConnectionStatus providerId={providerId} sshHost={null} dir="" compact={compact} />
    );

  const checking = recheck.isPending || reported.problem === 'login not checked yet';
  const headline = recheck.isPending
    ? 'Checking installation and sign-in…'
    : reportedHeadline(reported);
  const Icon = checking ? Loader2 : reported.ready ? CheckCircle2 : CircleAlert;
  const tone = checking || reported.ready ? 'text-foreground-muted' : 'text-foreground-warning';
  if (compact)
    return (
      <span className={`inline-flex items-center gap-1.5 text-xs ${tone}`}>
        <Icon className={`size-3.5 ${checking ? 'animate-spin' : ''}`} />
        {headline}
      </span>
    );
  const provider = getProvider(providerId);
  return (
    <div className="rounded-lg border border-border bg-background-1 p-3 text-sm" role="status">
      <div className="flex items-center gap-2">
        <Icon className={`size-4 shrink-0 ${tone} ${checking ? 'animate-spin' : ''}`} />
        <span className="font-medium">
          {provider?.name ?? providerId} · {headline}
        </span>
        <Button
          className="ml-auto shrink-0"
          size="sm"
          variant="ghost"
          disabled={recheck.isPending}
          onClick={() => recheck.mutate()}
          aria-label="Recheck installation and sign-in"
        >
          <RefreshCw className={`size-3.5 ${recheck.isPending ? 'animate-spin' : ''}`} />
          Recheck
        </Button>
      </div>
      <p className="mt-1 text-xs text-foreground-muted">
        On this computer, as its agent controller reported it to Switch
      </p>
      {!recheck.isPending && reported.detail && (
        <p className="mt-2 text-foreground-muted">{reported.detail}</p>
      )}
      {!recheck.isPending &&
        !reported.ready &&
        reported.loginHelps &&
        provider &&
        reported.problem !== 'not installed' && (
          <p className="mt-2 text-foreground-muted">
            Run <code className="text-xs select-all">{provider.loginCommand}</code> in a terminal on
            this computer, then Recheck.
          </p>
        )}
    </div>
  );
}

function Checking({ compact }: { compact: boolean }) {
  const line = (
    <span className="inline-flex items-center gap-1.5 text-xs text-foreground-muted">
      <Loader2 className="size-3.5 animate-spin" />
      Checking installation and sign-in…
    </span>
  );
  if (compact) return line;
  return (
    <div className="rounded-lg border border-border bg-background-1 p-3 text-sm" role="status">
      {line}
    </div>
  );
}
