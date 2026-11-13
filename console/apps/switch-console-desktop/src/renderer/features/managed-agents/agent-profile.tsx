import { type AgentLine, AgentProfileHeader } from '@switch-console/chat-ui/components/agent-page';
import { Cloud, Laptop, type LucideIcon, Plug, ServerOff, Settings } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import { isCloudMachine, type ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import type { AgentSection } from './agent-sections';
import { managedAgentState } from './managed-agent-state';

const SECTION_BUTTONS = [
  { section: 'connections', label: 'Connectors', icon: Plug },
  { section: 'settings', label: 'Agent settings', icon: Settings },
] as const satisfies readonly { section: AgentSection; label: string; icon: LucideIcon }[];

export const agentSectionLabel = (section: AgentSection): string =>
  SECTION_BUTTONS.find((item) => item.section === section)!.label;

/** Where an agent runs, as the one line under its name says it. */
export type AgentMachineLine = AgentLine;

/**
 * The machine a managed agent runs on, and how the agent is doing there when
 * not running. This computer goes by that name, with its own in the hover text.
 */
export function managedAgentMachineLine(
  agent: ManagedAgentView,
  thisComputer: boolean
): AgentMachineLine {
  const machine = agent.machine;
  if (!machine)
    return {
      icon: ServerOff,
      text: 'No machine',
      status: null,
      title: 'It has no machine to run on.',
    };
  const cloud = isCloudMachine(machine);
  const name = machine.name;
  const shown = thisComputer && !cloud ? 'This computer' : name;
  const state = managedAgentState(agent);
  const directory = agent.definition.directory;
  return {
    icon: cloud ? Cloud : Laptop,
    text: shown,
    status: state.tone === 'ok' ? null : state.label,
    title: `Runs on ${shown === name ? name : `this computer (${name})`}${directory ? ` · ${directory}` : ''}${state.detail ? `\n${state.label}: ${state.detail}` : ''}`,
  };
}

/**
 * The top of an agent's page: its picture, its name and where it runs, and a
 * button for each of the agent's own sections. `onSelect` is null while the
 * agent does not exist yet, so the buttons show but do nothing. With
 * `onOpenMachine` the line saying where it runs opens that machine's page.
 */
export function AgentProfile({
  name,
  iconUrl,
  serverId,
  machine,
  sections,
  selected,
  onSelect,
  onOpenMachine,
}: {
  name: string;
  iconUrl: string | null;
  serverId: string;
  machine: AgentMachineLine;
  sections: readonly AgentSection[];
  selected: AgentSection | null;
  onSelect: ((section: AgentSection) => void) | null;
  onOpenMachine: (() => void) | null;
}) {
  return (
    <AgentProfileHeader
      name={name}
      iconUrl={iconUrl}
      serverId={serverId}
      line={machine}
      onOpenLine={onOpenMachine}
    >
      <div role="toolbar" aria-label="Agent" className="mt-5 flex items-center gap-2">
        {SECTION_BUTTONS.filter((item) => sections.includes(item.section)).map((item) => {
          const active = selected === item.section;
          return (
            <Tooltip key={item.section}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={item.label}
                    aria-pressed={active}
                    disabled={onSelect === null}
                    onClick={() => onSelect?.(item.section)}
                    className={cn(
                      'flex size-9 items-center justify-center rounded-lg bg-background-2 text-foreground-muted transition-colors hover:bg-background-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
                      active && 'bg-background-3 text-foreground ring-1 ring-border-1 ring-inset'
                    )}
                  >
                    <item.icon className="size-4" />
                  </button>
                }
              />
              <TooltipContent>{item.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </AgentProfileHeader>
  );
}
