import { AlertTriangle, Moon } from 'lucide-react';
import { Button } from '@renderer/lib/ui/button';
import type { CloudRelayProblem } from '@shared/core/cloud-agents/cloud-agents';
import type { CloudProblemAction } from './use-cloud-agents';

/** What a relay code means to the user, beside the server's own message. */
const PROBLEM_TITLES: Record<string, string> = {
  machine_stopped: 'The owner stopped the cloud machine.',
  machine_error: 'The cloud machine is in error.',
  worker_sleeping: 'The cloud machine is asleep.',
  worker_waking: 'The cloud machine is starting.',
  agent_stopped: 'The agent is stopped.',
  agent_crashed: 'The agent crashed.',
  worker_not_attached: 'The cloud worker is not attached.',
  worker_busy: 'The cloud worker is busy. Try again shortly.',
  generation_changed: 'The cloud worker restarted.',
  relay_timeout: 'The cloud worker did not answer in time.',
  refused_message: 'Switch refused the request.',
  too_large: 'The request is too large for the relay.',
  not_found: 'Switch does not know this cloud agent.',
};

/**
 * Why a cloud agent's worker cannot be reached, said as such, with what the
 * user can do about it. A sleeping machine that can be woken and offers no
 * Wake here wakes on the next message sent to it.
 * A `worker_waking` on a machine already up is only the agent starting.
 */
export function CloudProblem({
  problem,
  machineReady,
  compact,
  action,
}: {
  problem: CloudRelayProblem;
  machineReady: boolean;
  compact: boolean;
  action: CloudProblemAction | null;
}) {
  const sleeping = problem.code === 'worker_sleeping';
  const agentStarting = problem.code === 'worker_waking' && machineReady;
  const Icon = sleeping ? Moon : AlertTriangle;
  return (
    <div
      role={sleeping ? 'status' : 'alert'}
      className={`flex items-center gap-2 rounded-md bg-background-secondary text-xs ${compact ? 'px-2 py-1.5' : 'px-3 py-2'} ${sleeping ? 'text-foreground-muted' : 'text-foreground-destructive'}`}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 leading-5">
        {agentStarting
          ? 'The agent is starting.'
          : (PROBLEM_TITLES[problem.code] ??
            (compact ? problem.message : 'The cloud worker could not be reached.'))}{' '}
        {!compact && !agentStarting && problem.message !== PROBLEM_TITLES[problem.code] && (
          <span className="text-foreground-muted">{problem.message} </span>
        )}
        {sleeping && problem.wakeAvailable && !action && 'Send a message to wake it. '}
        {action?.error && (
          <span role="alert" className="block text-foreground-destructive">
            {action.error}
          </span>
        )}
      </span>
      {action && (
        <Button
          size="sm"
          variant="outline"
          className="h-6 shrink-0 px-2 text-xs"
          disabled={action.pending}
          onClick={action.run}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
