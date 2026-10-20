import { Cloud, Laptop, type LucideIcon, Plug, ServerOff, Settings } from 'lucide-react';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
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
export type AgentMachineLine = {
  icon: LucideIcon;
  text: string;
  /** Hover text, saying more than fits on the line. */
  title: string;
};

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
    return { icon: ServerOff, text: 'No machine', title: 'It has no machine to run on.' };
  const cloud = isCloudMachine(machine);
  const name = machine.name;
  const shown = thisComputer && !cloud ? 'This computer' : name;
  const state = managedAgentState(agent);
  const directory = agent.definition.directory;
  return {
    icon: cloud ? Cloud : Laptop,
    text: state.tone === 'ok' ? shown : `${shown} · ${state.label}`,
    title: `Runs on ${shown === name ? name : `this computer (${name})`}${directory ? ` · ${directory}` : ''}${state.detail ? `\n${state.label}: ${state.detail}` : ''}`,
  };
}

/**
 * The top of an agent's page: its picture, its name and where it runs, and a
 * button for each of the agent's own sections. `onSelect` is null while the
 * agent does not exist yet, so the buttons show but do nothing.
 */
export function AgentProfile({
  name,
  iconUrl,
  serverId,
  machine,
  sections,
  selected,
  onSelect,
}: {
  name: string;
  iconUrl: string | null;
  serverId: string;
  machine: AgentMachineLine;
  sections: readonly AgentSection[];
  selected: AgentSection | null;
  onSelect: ((section: AgentSection) => void) | null;
}) {
  const MachineIcon = machine.icon;
  return (
    <div className="flex flex-col items-center px-2 pt-4 pb-6 text-center">
      <span className="flex size-24 shrink-0 items-center justify-center rounded-[22%] bg-background-2">
        <AgentAvatar name={name} iconUrl={iconUrl} serverId={serverId} size={76} />
      </span>
      <h2 className="mt-4 max-w-full truncate text-base font-semibold text-foreground">{name}</h2>
      <p
        className="mt-0.5 flex max-w-full items-center gap-1.5 text-sm text-foreground-muted"
        title={machine.title}
      >
        <MachineIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{machine.text}</span>
      </p>
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
    </div>
  );
}
