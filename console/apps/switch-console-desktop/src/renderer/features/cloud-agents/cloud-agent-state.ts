import type { SessionStateTone } from '@renderer/features/sessions/components/transcript/session-state';
import { type CloudAgent, cloudLaunchPhase } from '@shared/core/cloud-agents/cloud-agents';

/**
 * A cloud agent's state when its worker cannot be asked, read the same way in
 * the sidebar and in a session's header; null while the worker answers.
 */
export function cloudAgentState(
  agent: CloudAgent
): { label: string; tone: SessionStateTone } | null {
  const phase = cloudLaunchPhase(agent.launch);
  if (phase === 'sleeping') return { label: 'sleeping', tone: 'idle' };
  if (phase === 'waking') return { label: 'waking…', tone: 'busy' };
  if (agent.launch.state === 'error') return { label: 'error', tone: 'bad' };
  if (agent.problem) return { label: 'unreachable', tone: 'bad' };
  return null;
}
