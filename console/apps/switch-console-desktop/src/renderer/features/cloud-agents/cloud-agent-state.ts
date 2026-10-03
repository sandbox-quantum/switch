import { relayRefusal } from '@renderer/features/sessions/components/transcript/held-message';
import type { SessionStateTone } from '@renderer/features/sessions/components/transcript/session-state';
import {
  type CloudAgent,
  cloudAgentPhase,
  cloudMachineReady,
} from '@shared/core/cloud-agents/cloud-agents';

/**
 * A cloud agent's state when its worker cannot be asked, read the same way in
 * the sidebar and in a session's header; null while the worker answers.
 */
export function cloudAgentState(
  agent: CloudAgent
): { label: string; tone: SessionStateTone } | null {
  if (agent.launch.desired_state === 'deleted') return { label: 'removing…', tone: 'idle' };
  const phase = cloudAgentPhase(agent.launch, agent.machine);
  if (phase === 'sleeping') return { label: 'sleeping', tone: 'idle' };
  if (phase === 'machine_stopped') return { label: 'machine stopped', tone: 'idle' };
  if (phase === 'machine_error') return { label: 'machine error', tone: 'bad' };
  if (phase === 'waking')
    return { label: cloudMachineReady(agent.machine) ? 'starting…' : 'waking…', tone: 'busy' };
  if (agent.launch.desired_state === 'stopped') return { label: 'stopped', tone: 'idle' };
  if (agent.launch.process_state === 'crashed' || agent.launch.error_code === 'agent_crashed')
    return { label: 'crashed', tone: 'bad' };
  if (agent.launch.state === 'error') return { label: 'error', tone: 'bad' };
  if (agent.problem) return { label: 'unreachable', tone: 'bad' };
  return null;
}

/**
 * Why a message held for a waking machine will not be delivered without the
 * user acting, or null while it still may be.
 */
export function cloudHoldBlocker(agent: CloudAgent): string | null {
  const { launch } = agent;
  if (launch.desired_state === 'deleted') return 'This agent is being removed.';
  const phase = cloudAgentPhase(launch, agent.machine);
  if (phase === 'machine_stopped') return relayRefusal(phase);
  if (phase === 'machine_error') {
    return agent.machine?.error_code === 'machine_needs_attention'
      ? 'The cloud machine needs attention. Contact your server administrator.'
      : relayRefusal(phase);
  }
  if (launch.desired_state === 'stopped') return relayRefusal('agent_stopped');
  if (launch.process_state === 'crashed' || launch.error_code === 'agent_crashed')
    return relayRefusal('agent_crashed');
  if (launch.state === 'error' && launch.error_code === 'agent_key_missing')
    return 'Switch lost this agent’s credential. Remove it in Your Agents and create it again.';
  if (launch.state === 'error')
    return 'This agent could not start. Retry it in Your Agents, then send again.';
  return null;
}
