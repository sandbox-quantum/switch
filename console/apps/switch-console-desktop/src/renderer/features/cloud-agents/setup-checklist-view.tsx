import { Check, Circle } from 'lucide-react';
import { useState } from 'react';
import { GiveMachineLogin } from '@renderer/features/locations/components/add-agent-modal/give-machine-login';
import {
  useManagedAgents,
  useOwnedMachines,
} from '@renderer/features/managed-agents/use-managed-agents';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import type { CloudMachine } from '@shared/core/cloud-agents/cloud-agents';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import { isValidProviderId } from '@shared/core/providers/agent-provider-registry';
import { PEOPLE_WORDS } from './people-words';
import { type ChecklistLine, setupChecklist } from './setup-checklist';
import type { YourCloudView } from './your-cloud';

const W = PEOPLE_WORDS.checklist;

/**
 * Your cloud's setup checklist on Console's card: three lines with a tick or
 * the next step (Start, Give login, Add agent), the same as Switch web. It
 * reads only what Console already loads (the box, and the machine list the
 * card's Repair already asks for), and folds away once all three are ticked.
 */
export function SetupChecklist({
  lines,
  controller,
  serverId,
  pending,
  onStart,
}: {
  lines: ChecklistLine[];
  /** The box's controller, to give a login to. */
  controller: OwnedMachine | null | undefined;
  serverId: string;
  pending: boolean;
  onStart: (how: 'ensure' | 'lifecycle') => void;
}) {
  const showAddAgentModal = useShowModal('addAgentModal');
  const [giving, setGiving] = useState<string | null>(null);
  return (
    <div className="mt-3 max-w-[420px] space-y-1.5" data-setup-checklist="">
      <ul className="space-y-1.5">
        {lines.map((line) => (
          <li
            key={line.key}
            data-checklist-line={line.key}
            data-done={line.done ? 'true' : 'false'}
            className="flex items-center justify-between gap-2 text-xs"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {line.done ? (
                <Check className="size-3.5 shrink-0 text-foreground-success" aria-label="Done" />
              ) : (
                <Circle className="size-3.5 shrink-0 text-foreground-muted" aria-label="Not yet" />
              )}
              <span className={line.done ? 'text-foreground' : 'text-foreground-muted'}>
                {line.text}
              </span>
            </span>
            {line.action?.kind === 'start' && (
              <Button
                variant="outline"
                size="xs"
                disabled={pending}
                onClick={() => line.action?.kind === 'start' && onStart(line.action.how)}
              >
                {W.start}
              </Button>
            )}
            {line.action?.kind === 'give_login' && giving === null && (
              <Button
                variant="outline"
                size="xs"
                onClick={() =>
                  line.action?.kind === 'give_login' && setGiving(line.action.provider)
                }
              >
                {W.giveLogin}
              </Button>
            )}
            {line.action?.kind === 'add_agent' && (
              <Button
                variant="outline"
                size="xs"
                onClick={() => showAddAgentModal({ entryPoint: 'server_page' })}
              >
                {W.addAgent}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {giving && controller && isValidProviderId(giving) && (
        <GiveMachineLogin
          serverId={serverId}
          machine={controller}
          provider={giving}
          onClose={() => setGiving(null)}
        />
      )}
    </div>
  );
}

/**
 * The box card's checklist, with its read of the machine list kept to the box
 * card only (a v1 machine's card asks for nothing new). A stopped box's Start
 * lives here: on the checklist's first line, or as a plain button while the
 * machine list is still loading, so Start is never missing or shown twice.
 */
export function BoxSetupChecklist({
  machine,
  serverId,
  view,
  pending,
  blocked,
  onStart,
}: {
  machine: CloudMachine;
  serverId: string;
  view: YourCloudView;
  pending: boolean;
  /** Switch paused it or the admin turned it off: no Start is offered. */
  blocked: boolean;
  onStart: (how: 'ensure' | 'lifecycle') => void;
}) {
  const owned = useOwnedMachines(serverId);
  // A failed read counts as "no controller row": the checklist still shows, with no Give login.
  const controller = owned.isError
    ? null
    : owned.data
      ? (owned.data.find((candidate) => candidate.id === machine.controller_id) ?? null)
      : undefined;
  // The providers the box's agents use, from the agent list Your Agents already loads.
  const managed = useManagedAgents(serverId);
  const agentProviders = managed.isError
    ? null
    : managed.data
      ? [
          ...new Set(
            managed.data
              .filter((agent) => machine.agents.includes(agent.agentId))
              .map((agent) => agent.definition.provider)
          ),
        ]
      : managed.isLoading
        ? undefined
        : null;
  const lines = setupChecklist({ view, agents: machine.agents, controller, agentProviders });
  if (lines)
    return (
      <SetupChecklist
        lines={
          blocked
            ? lines.map((line) => (line.key === 'cloud' ? { ...line, action: null } : line))
            : lines
        }
        controller={controller}
        serverId={serverId}
        pending={pending}
        onStart={onStart}
      />
    );
  if (stoppedStart(view) && !blocked)
    return (
      <div className="mt-2">
        <Button variant="outline" size="sm" disabled={pending} onClick={() => onStart(view.start!)}>
          {pending ? 'Starting…' : W.start}
        </Button>
      </div>
    );
  return null;
}

/** Whether Your cloud's own Start is a stopped box's (the checklist's), not a resting box's Wake. */
export function stoppedStart(
  view: YourCloudView
): view is YourCloudView & { start: 'ensure' | 'lifecycle' } {
  return view.resting && view.heading === 'Stopped' && view.start !== undefined;
}
