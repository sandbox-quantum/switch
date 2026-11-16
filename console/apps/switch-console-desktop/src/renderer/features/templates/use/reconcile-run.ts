import type { TemplateRunSoFar } from '@main/core/switch-servers/gateway-client';
import type { SlotStatus } from './creates-rail';

/**
 * How a run that outlasted Switch Console's wait stands, read back from the
 * server: `running` while an attempt is still going, `stopped` when none is
 * and something is missing, `unknown` when the server could not be asked.
 */
export type OutlastedState = 'running' | 'stopped' | 'unknown';

export type ReconciledRun = {
  state: OutlastedState;
  /** Each agent the attempt was making, by the name it was to have. */
  agents: Map<string, { status: SlotStatus; agentId: string | null; error: string | null }>;
  /** The room step; null when the run makes no room. */
  room: { status: SlotStatus; roomId: string | null; roomName: string | null } | null;
  /** Everything the run makes exists, and no attempt is still going. */
  complete: boolean;
  /** What to tell the person, under the steps; null when the run is complete. */
  message: string | null;
};

const UNKNOWN_STEP = 'Not known: the server could not be asked whether this was made.';
const NOT_MADE = 'Not made: the attempt ended before this step.';

/**
 * Each step's real outcome after the request timed out: done when the server
 * has it, still running while an attempt holds the run, failed when no
 * attempt does and it is missing. With no answer from the server, nothing is
 * claimed either way: never "Nothing was created" while something may exist.
 */
export function reconcileRun(input: {
  agentNames: string[];
  /** How many rooms the run makes; 0 for none. */
  roomCount: number;
  soFar: TemplateRunSoFar | null;
}): ReconciledRun {
  const { agentNames, roomCount, soFar } = input;
  const agents: ReconciledRun['agents'] = new Map();
  if (soFar === null) {
    for (const name of agentNames)
      agents.set(name, { status: 'failed', agentId: null, error: UNKNOWN_STEP });
    return {
      state: 'unknown',
      agents,
      room: roomCount > 0 ? { status: 'failed', roomId: null, roomName: null } : null,
      complete: false,
      message:
        'Switch Console stopped waiting for the server and could not read back what it made. ' +
        'Check Your Agents and the sidebar before you retry: Retry finishes what is missing and ' +
        'makes nothing twice.',
    };
  }
  const missing: SlotStatus = soFar.inFlight ? 'creating' : 'failed';
  const made = new Map(soFar.agents.map((a) => [a.name, a.agentId]));
  for (const name of agentNames) {
    const agentId = made.get(name) ?? null;
    agents.set(
      name,
      agentId !== null
        ? { status: 'created', agentId, error: null }
        : { status: missing, agentId: null, error: soFar.inFlight ? null : NOT_MADE }
    );
  }
  const first = soFar.rooms[0] ?? null;
  const roomsDone =
    roomCount > 0 && soFar.rooms.length >= roomCount && soFar.rooms.every((r) => r.kickoffPosted);
  const room =
    roomCount === 0
      ? null
      : {
          status: roomsDone ? ('created' as const) : missing,
          roomId: first?.roomId ?? null,
          roomName: first?.roomName ?? null,
        };
  const agentsDone = [...agents.values()].every((a) => a.status === 'created');
  const complete = !soFar.inFlight && agentsDone && (roomCount === 0 || roomsDone);
  return {
    state: complete ? 'stopped' : soFar.inFlight ? 'running' : 'stopped',
    agents,
    room,
    complete,
    message: complete
      ? null
      : soFar.inFlight
        ? 'The server is still working on this run; each step shows how far it has got. ' +
          'Retry once it has finished: Retry finishes what is missing and makes nothing twice.'
        : 'The run stopped partway. What was made stays made, and Retry finishes the rest.',
  };
}
