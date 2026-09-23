export type AgentConnectionState =
  | 'connected'
  | 'connecting'
  | 'stopped'
  | 'failed'
  | 'taken-over'
  | 'unknown';
export type AgentConnectionHealth = {
  agentId: string;
  state: AgentConnectionState;
  detail: string | null;
};
export const connectionLabels: Record<AgentConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  stopped: 'Stopped by you',
  failed: 'Connection failed',
  'taken-over': 'Connected elsewhere',
  unknown: 'Could not check connection',
};
export function connectionNeedsAttention(state: AgentConnectionState): boolean {
  return state === 'failed' || state === 'taken-over' || state === 'unknown';
}
export function classifyConnection(input: {
  stopped: boolean;
  running: boolean;
  connected: boolean;
  takenOver: boolean;
  disconnectedFor: number;
}): AgentConnectionState {
  if (input.stopped) return 'stopped';
  if (input.takenOver) return 'taken-over';
  if (input.running && input.connected) return 'connected';
  // Persisted crash messages can belong to the previous Console run. Give
  // the existing connection grace period time to establish current state.
  if (input.disconnectedFor >= 15_000) return 'failed';
  return 'connecting';
}
