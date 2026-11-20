import {
  type AgentLine,
  AgentProfileHeader,
  ProfileButton,
} from '@switch-console/chat-ui/components/agent-page';
import { Cloud, Laptop, type LucideIcon, Plug, ServerOff, Settings } from 'lucide-react';
import type { ReactNode } from 'react';
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
  actions,
}: {
  name: string;
  iconUrl: string | null;
  serverId: string;
  machine: AgentMachineLine;
  sections: readonly AgentSection[];
  selected: AgentSection | null;
  onSelect: ((section: AgentSection) => void) | null;
  onOpenMachine: (() => void) | null;
  /** The agent's own actions (turning it off, moving it), after its sections. */
  actions?: ReactNode;
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
            <ProfileButton
              key={item.section}
              label={item.label}
              icon={item.icon}
              pressed={active}
              disabled={onSelect === null}
              onClick={() => onSelect?.(item.section)}
            />
          );
        })}
        {actions}
      </div>
    </AgentProfileHeader>
  );
}
