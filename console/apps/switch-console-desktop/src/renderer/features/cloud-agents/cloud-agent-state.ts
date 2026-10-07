import { relayRefusal } from '@renderer/features/sessions/components/transcript/held-message';
import type { SessionStateTone } from '@renderer/features/sessions/components/transcript/session-state';
import {
  type CloudAgent,
  cloudAgentPhase,
  cloudMachineReady,
  controllerAgentCrashed,
} from '@shared/core/cloud-agents/cloud-agents';

/**
 * A cloud agent's state when it cannot be asked, read the same way in the
 * sidebar and in a session's header; null while it answers.
 */
export function cloudAgentState(
  agent: CloudAgent
): { label: string; tone: SessionStateTone } | null {
  const phase = cloudAgentPhase(agent.machine, agent.controller);
  if (phase === 'sleeping') return { label: 'sleeping', tone: 'idle' };
  if (phase === 'machine_stopped') return { label: 'machine stopped', tone: 'idle' };
  if (phase === 'machine_error') return { label: 'machine error', tone: 'bad' };
  if (phase === 'waking')
    return { label: cloudMachineReady(agent.machine) ? 'starting…' : 'waking…', tone: 'busy' };
  if (agent.controller.desiredState === 'stopped') return { label: 'stopped', tone: 'idle' };
  if (controllerAgentCrashed(agent.controller)) return { label: 'crashed', tone: 'bad' };
  if (agent.problem) return { label: 'unreachable', tone: 'bad' };
  return null;
}

/**
 * Why a message held for a waking machine will not be delivered without the
 * user acting, or null while it still may be.
 */
export function cloudHoldBlocker(agent: CloudAgent): string | null {
  const phase = cloudAgentPhase(agent.machine, agent.controller);
  if (phase === 'machine_stopped') return relayRefusal(phase);
  if (phase === 'machine_error') {
    return agent.machine?.error_code === 'machine_needs_attention'
      ? 'The cloud machine needs attention. Contact your server administrator.'
      : relayRefusal(phase);
  }
  if (agent.controller.desiredState === 'stopped') return relayRefusal('agent_stopped');
  if (controllerAgentCrashed(agent.controller)) return relayRefusal('agent_crashed');
  return null;
}
