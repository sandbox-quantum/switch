export type AgentConnectionState =
  | 'connected'
  | 'connecting'
  | 'stopped'
  | 'failed'
  | 'taken-over'
  | 'unreachable'
  | 'unknown';
export type AgentConnectionHealth = {
  agentId: string;
  state: AgentConnectionState;
  detail: string | null;
};
/** Every linked agent's connection, and which room each of their sessions is placed in. */
export type RoomHealthSnapshot = {
  agents: AgentConnectionHealth[];
  /** Session id → room id, as the agents' room watchers route now. */
  placements: Record<string, string>;
};
export const connectionLabels: Record<AgentConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  stopped: 'Stopped by you',
  failed: 'Connection failed',
  'taken-over': 'Connected elsewhere',
  unreachable: 'Sidecar not reachable',
  unknown: 'Could not check connection',
};
export function connectionNeedsAttention(state: AgentConnectionState): boolean {
  return (
    state === 'failed' || state === 'taken-over' || state === 'unreachable' || state === 'unknown'
  );
}

/** How long a watcher that is not connected yet is shown as connecting rather than failed. */
export const CONNECTION_GRACE_MS = 15_000;

/** What an agent's room watcher said about itself, or why it could not be asked. */
export type WatcherReport =
  | {
      kind: 'watcher';
      state:
        | 'not-running'
        | 'disabled'
        | 'taken-over'
        | 'connecting'
        | 'connected'
        | 'disconnected';
      detail: string | null;
      /** When the watcher entered `state`, in epoch milliseconds. */
      since: number;
    }
  | { kind: 'unreachable'; detail: string; takenOver: string | null };

/**
 * The connection state shown for an agent. `graceUntil` is set when the state
 * shown is `connecting` only because the watcher has not been down long
 * enough to call it failed: the state has to be worked out again then.
 */
export function classifyWatcher(input: { stopped: boolean; report: WatcherReport; now: number }): {
  state: AgentConnectionState;
  detail: string | null;
  graceUntil: number | null;
} {
  const { report } = input;
  if (input.stopped) return { state: 'stopped', detail: null, graceUntil: null };
  if (report.kind === 'unreachable')
    return report.takenOver !== null
      ? { state: 'taken-over', detail: report.takenOver, graceUntil: null }
      : { state: 'unreachable', detail: report.detail, graceUntil: null };
  switch (report.state) {
    case 'connected':
      return { state: 'connected', detail: null, graceUntil: null };
    case 'connecting':
      return { state: 'connecting', detail: null, graceUntil: null };
    case 'taken-over':
      return { state: 'taken-over', detail: report.detail, graceUntil: null };
    case 'disabled':
      return { state: 'stopped', detail: null, graceUntil: null };
    case 'disconnected':
    case 'not-running': {
      const graceUntil = report.since + CONNECTION_GRACE_MS;
      // A watcher that stopped on an error has failed; there is nothing to wait for.
      if (input.now < graceUntil && !(report.state === 'not-running' && report.detail))
        return { state: 'connecting', detail: report.detail, graceUntil };
      return {
        state: 'failed',
        detail:
          report.detail ??
          (report.state === 'not-running' ? "The agent's room watcher is not running." : null),
        graceUntil: null,
      };
    }
  }
}
