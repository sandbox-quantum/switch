/**
 * Subagent activity tracking types.
 *
 * These types match the backend schema for reporting active subagent state
 * as part of agent runtime state updates.
 */

/**
 * The current state of a subagent spawned by the primary agent.
 */
export type SubagentState = 'working' | 'awaiting-input' | 'idle' | 'complete' | 'failed';

/**
 * Activity information for a single subagent, reported to the backend
 * as part of the agent's runtime state.
 */
export interface SubagentActivity {
  agent_id: string;
  agent_name: string;
  state: SubagentState;
  detail: string | null;
}
