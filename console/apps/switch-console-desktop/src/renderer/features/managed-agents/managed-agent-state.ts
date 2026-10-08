import type { ManagedAgentView, OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import { providerDisplayName } from '@shared/core/providers/agent-provider-registry';

export type ManagedAgentState = {
  label: string;
  tone: 'ok' | 'busy' | 'idle' | 'problem';
  /** Why, in the machine's words, when it reported a reason. */
  detail: string | null;
};

/** How a managed agent is doing, from what the server says of it and of its machine. */
export function managedAgentState(agent: ManagedAgentView): ManagedAgentState {
  const status = agent.status;
  const detail = status?.detail ?? status?.reason ?? null;
  if (!agent.machine) return { label: 'No machine', tone: 'problem', detail: null };
  if (agent.machine.state === 'revoked')
    return { label: 'Machine removed', tone: 'problem', detail: null };
  if (agent.desiredState === 'stopped') {
    const stillUp =
      status && ['pending', 'starting', 'running', 'stopping'].includes(status.process);
    return stillUp
      ? { label: 'Stopping', tone: 'busy', detail: null }
      : { label: 'Stopped', tone: 'idle', detail: null };
  }
  if (agent.machine.state !== 'online')
    return { label: 'Machine offline', tone: 'problem', detail: null };
  if (!status) return { label: 'Starting', tone: 'busy', detail: null };
  switch (status.process) {
    case 'running':
      return status.attached
        ? { label: 'Running', tone: 'ok', detail: null }
        : { label: 'Connecting', tone: 'busy', detail };
    case 'crashed':
    case 'failed':
      return { label: 'Failed', tone: 'problem', detail };
    case 'pending':
    case 'starting':
    case 'stopped':
      return { label: 'Starting', tone: 'busy', detail };
    default:
      return { label: status.process, tone: 'busy', detail };
  }
}

/**
 * Where a machine makes an agent's workspace when the agent names no directory:
 * its workspaces folder, then the agent's name. Null when the machine has not
 * said where it keeps them, or there is no name yet.
 */
export function machineWorkspaceFor(machine: OwnedMachine, name: string): string | null {
  const dir = machine.workspacesDir;
  if (dir === null || name.trim() === '') return null;
  const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${separator}${name.trim()}`;
}

export function managedAgentLabel(agent: ManagedAgentView): string {
  return agent.displayName || agent.name;
}

/**
 * What is wrong with where the agent runs, in a sentence, or null when nothing
 * is. `machine` is the owner's machine as the server lists it, null while that
 * list is not in (or no longer names it), when only the agent's own copy of its
 * machine is known.
 */
export function machineProblem(
  agent: ManagedAgentView,
  machine: OwnedMachine | null
): string | null {
  if (!agent.machine) return 'This agent is placed on no machine, so nothing runs it.';
  const name = agent.machine.name;
  if (agent.machine.state === 'revoked')
    return `${name} was removed from your machines, so nothing runs this agent.`;
  if (agent.machine.state !== 'online')
    return `${name} stopped answering. The agent resumes when it reconnects.`;
  const state = managedAgentState(agent);
  if (state.tone === 'problem')
    return state.detail ?? `The agent ${state.label.toLowerCase()} on ${name}.`;
  const provider = machine?.providers.find((entry) => entry.provider === agent.definition.provider);
  if (provider && !provider.ready) {
    const label = providerDisplayName(provider.provider) ?? provider.provider;
    return `${label} is not ready on ${name}${provider.problem ? `: ${provider.problem}` : ''}.`;
  }
  return null;
}

/** The colour of the dot beside the agent's machine: green when all is well, red on a problem. */
export function machineTone(
  agent: ManagedAgentView,
  machine: OwnedMachine | null
): 'ok' | 'problem' | 'idle' {
  if (machineProblem(agent, machine) !== null) return 'problem';
  return managedAgentState(agent).tone === 'ok' ? 'ok' : 'idle';
}
