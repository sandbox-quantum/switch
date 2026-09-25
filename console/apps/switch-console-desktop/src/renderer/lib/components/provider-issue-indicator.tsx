import { CircleAlert } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { getProvider, type AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { loginCommands, providerProblem, useProviderReadiness } from './provider-connection-status';

/**
 * A warning beside an agent whose provider cannot run on the agent's machine:
 * the CLI is missing, or not signed in. Nothing when it is ready, or when the
 * check could not tell. An unknown is not a fault worth a warning.
 */
export function ProviderIssueIndicator({
  providerId,
  sshHost,
  hostReachable,
  onOpen,
}: {
  providerId: AgentProviderId;
  sshHost: string | null;
  /** A host already known to be down is not probed; its own indicator says so. */
  hostReachable: boolean;
  onOpen: () => void;
}) {
  const { data } = useProviderReadiness(providerId, sshHost, '', hostReachable);
  const problem = providerProblem(data);
  if (!problem) return null;
  const name = getProvider(providerId)?.name ?? providerId;
  const where = sshHost ? `on ${sshHost}` : 'on this computer';
  const fix =
    data?.installed === false
      ? `Install the ${name} CLI ${where}.`
      : data?.status === 'unauthenticated'
        ? `Run \`${loginCommands[providerId]}\` ${where}.`
        : data?.message;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${name}: ${problem} ${where}. Open agent settings`}
            className="inline-flex shrink-0 items-center text-foreground-warning"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          >
            <CircleAlert className="h-3.5 w-3.5" />
          </button>
        }
      />
      <TooltipContent>
        {name}: {problem.toLowerCase()} {where}. {fix}
      </TooltipContent>
    </Tooltip>
  );
}
