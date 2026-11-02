import { type ChatAgent, chatAgentLabel } from '@shared/core/chats/chats';
import { isCloudMachine, type ManagedAgentView } from '@shared/core/managed-agents/managed-agents';

export type ChatAvailability = {
  /** Sending is held back: a 1:1 chat whose agent's machine is known to be offline. */
  block: boolean;
  /** What the bar above the composer says, or null when there is nothing to say. */
  bar: string | null;
  /** Agents whose machine is known to be offline; a cloud machine wakes on a message, so is not. */
  offlineAgentIds: string[];
};

export const AVAILABLE: ChatAvailability = { block: false, bar: null, offlineAgentIds: [] };

/**
 * Whether the chat's agents can answer, from the viewer's managed agents. An
 * agent that is not one of them, or whose machine is not known to be offline,
 * never blocks. A Switch cloud machine is woken by the message itself, so it
 * reads as waking up rather than offline.
 */
export function chatAvailability(
  agents: ChatAgent[],
  otherPeople: number,
  managed: ManagedAgentView[] | null | undefined
): ChatAvailability {
  const direct = agents.length === 1 && otherPeople === 0;
  const offlineAgentIds: string[] = [];
  const notes: string[] = [];
  for (const agent of agents) {
    const machine = managed?.find((each) => each.agentId === agent.id)?.machine;
    if (machine?.state !== 'offline') continue;
    if (isCloudMachine(machine)) {
      notes.push(`${machine.name} is waking up…`);
      continue;
    }
    offlineAgentIds.push(agent.id);
    notes.push(
      direct
        ? `${machine.name} is offline. ${chatAgentLabel(agent)} can't reply until it's back.`
        : `${chatAgentLabel(agent)}'s machine (${machine.name}) is offline.`
    );
  }
  if (notes.length === 0) return AVAILABLE;
  return { block: direct && offlineAgentIds.length > 0, bar: notes.join(' '), offlineAgentIds };
}
