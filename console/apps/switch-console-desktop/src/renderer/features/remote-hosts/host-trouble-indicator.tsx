/**
 * Why an agent's host is a problem, on the agent's own row (CHOO-1809).
 *
 * Surfaces deviation only — a healthy host adds nothing, because a green tick
 * on every row is noise that trains people to stop reading the column.
 *
 * Both reachability and readiness are handled here, in that order, so the two
 * sidebar trees cannot disagree with each other or with the host page: a host
 * that is down says *unreachable* and says nothing about its dependencies,
 * because we cannot see them from here.
 *
 * Readiness is judged for *this agent's own type*. A host missing a prerequisite
 * flags every agent on it; a host that is fine but lacks one agent CLI flags
 * only the agents of that type, rather than marking a working Claude Code agent
 * as broken because Codex is absent.
 */

import { CircleFadingArrowUp, PlugZap, Wrench } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { deriveAgentTypeStatus } from '@shared/core/remote-hosts/host-status';
import {
  agentTypeSteps,
  outstandingRequiredHostSteps,
  outstandingRequiredStepsFor,
  type HostSetupPlan,
  type HostSetupStep,
} from '@shared/core/remote-hosts/setup';
import { hostReachabilityStore } from './host-reachability-store';
import { hostSetupStore } from './host-setup-store';

const ICON = 'h-3.5 w-3.5 shrink-0 text-foreground-warning';

/**
 * This agent type's Switch connector, when it is installed but behind.
 *
 * The agent's own CLI is deliberately excluded. A newer release of it changes
 * nothing about whether the agent works here, and an icon in the sidebar is a
 * claim that something wants attention — which put a mark against hosts that
 * were entirely fine. The connector is ours and worth chasing; the CLI is
 * reported on the host's own page, where someone has gone to look.
 *
 * Only steps carrying a known newer version qualify. `updateAvailable` is never
 * set off a version we could not read, and it is additionally gated on the
 * update being one Switch Console could actually perform, so an icon here always
 * corresponds to a button that works.
 */
function staleStepsFor(plan: HostSetupPlan | null, agentId: string): HostSetupStep[] {
  if (!plan) return [];
  return agentTypeSteps(plan, agentId).filter(
    (step) =>
      step.kind === 'agent-plugin' &&
      step.state === 'satisfied' &&
      step.updateAvailable &&
      step.latestVersion
  );
}

export const HostTroubleIndicator = observer(function HostTroubleIndicator({
  sshHost,
  agentId,
}: {
  /** Null for a local agent, which has no host to be in trouble. */
  sshHost: string | null;
  /** This agent's type, so its host's other agent types are not held against it. */
  agentId: string | null;
}) {
  useEffect(() => {
    void hostSetupStore.hydrate();
  }, []);

  if (!sshHost) return null;

  const reachability = hostReachabilityStore.get(sshHost);
  const plan = hostSetupStore.get(sshHost);
  const status = deriveAgentTypeStatus(reachability, plan, agentId);

  // The host being down is why this agent is idle, so say so on the row itself
  // — previously you had to select the agent to discover its host was failing
  // to connect (CHOO-1682).
  if (status.kind === 'unreachable' || status.kind === 'auth-failed') {
    return (
      <Tooltip>
        <TooltipTrigger>
          <PlugZap className={ICON} aria-label="Host unavailable" />
        </TooltipTrigger>
        <TooltipContent>
          {status.kind === 'auth-failed'
            ? `SSH authentication to ${sshHost} failed — work is paused until you retry`
            : `Host ${sshHost} is unreachable — work is paused`}
          {reachability.lastError ? ` · ${reachability.lastError}` : ''}
        </TooltipContent>
      </Tooltip>
    );
  }

  // Nothing wrong, but something newer exists. Reported last and only when the
  // row is otherwise clean: an out-of-date connector still works, so it must
  // never displace a reason the agent is actually stuck.
  if (status.kind !== 'setup-required') {
    const stale = agentId ? staleStepsFor(plan, agentId) : [];
    if (stale.length === 0) return null;
    return (
      <Tooltip>
        <TooltipTrigger>
          {/*
            An up-arrow rather than the agents page's RefreshCw: on a row whose
            other two icons mean "broken", a refresh glyph reads as "retrying".
            Same warning tone as those, so it belongs to the same family.
          */}
          <CircleFadingArrowUp className={ICON} aria-label="Connector update available" />
        </TooltipTrigger>
        <TooltipContent>
          {`Connector update available on ${sshHost}: ${stale
            .map((step) => `${step.name} ${step.latestVersion}`)
            .join(', ')}`}
        </TooltipContent>
      </Tooltip>
    );
  }

  const missing = plan ? outstandingRequiredStepsFor(plan, agentId).map((step) => step.name) : [];
  const hostItself = !plan || outstandingRequiredHostSteps(plan).length > 0;
  return (
    <Tooltip>
      <TooltipTrigger>
        <Wrench className={ICON} aria-label="Setup required" />
      </TooltipTrigger>
      <TooltipContent>
        {hostItself
          ? `${sshHost} is missing something this agent needs`
          : `${sshHost} is ready, but this agent's type is not set up on it`}
        {missing.length > 0 ? `: ${missing.join(', ')}` : ''}
      </TooltipContent>
    </Tooltip>
  );
});
