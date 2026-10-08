/**
 * Where an agent's session for a chat runs, as seen from this machine, so the
 * chat can show what the agent is doing (tool cards, thinking, Stop, model,
 * approvals) beside the room messages.
 *
 * Found per agent, never from Switch: from the local room watcher's
 * placements, an SSH sidecar's, or — for a managed agent — its controller's
 * watcher, asked through the server's relay. Online is not placed, and placed
 * is not running: each is reported for what it is.
 */

export type ChatActivityHostTarget = 'local' | 'ssh' | 'controller';

export type ChatActivityUnavailableReason =
  /** The relay and the host are owner-only; someone else's agent shows no activity. */
  | 'not-owner'
  /** Not a local agent here and not a managed agent the person owns. */
  | 'not-on-this-machine'
  /** The agent's watcher runs, but no session of it is placed in this room. */
  | 'not-placed'
  /** The agent's watcher could not be asked. */
  | 'watcher-unreachable'
  /** A cloud agent's machine is asleep or starting: send wakes it. */
  | 'machine-asleep'
  /** Another controller is offline. */
  | 'controller-offline';

export type ChatActivityTarget =
  | {
      kind: 'unavailable';
      reason: ChatActivityUnavailableReason;
      message: string;
      /** For a sleeping cloud agent, the key its wake is asked with. */
      wakeAgentKey: string | null;
    }
  | {
      kind: 'session';
      target: ChatActivityHostTarget;
      /** What the session calls (`rpc.sdkHost.*`) name the agent by. */
      hostAgentKey: string;
      sessionId: string;
      /** The controller running it; null on a local or SSH host. */
      controllerId: string | null;
      /**
       * The controller watcher's run, as the moment its state began: a new
       * run is a new generation, so bindings keyed by it are dropped.
       */
      generation: string | null;
      /** A cloud machine agent, which can be woken. */
      cloud: boolean;
    };

export const ACTIVITY_UNAVAILABLE_TEXT: Record<ChatActivityUnavailableReason, string> = {
  'not-owner': 'Agent activity is visible to its owner.',
  'not-on-this-machine': 'Activity not available on this machine.',
  'not-placed': 'The agent has no session in this chat yet.',
  'watcher-unreachable': "The agent's room watcher cannot be reached.",
  'machine-asleep': 'The cloud machine is asleep. Sending a message wakes it.',
  'controller-offline':
    "The agent's controller is offline. Messages are kept and delivered when it reconnects.",
};

/**
 * The identity everything learned about one agent's activity in one chat is
 * kept under. A change in any part — another session, a new epoch, another
 * controller run — is a new key space: what was bound under the old one is
 * dropped, never carried over.
 */
export type ChatActivityKey = {
  serverId: string;
  tenantId: string | null;
  roomId: string;
  agentId: string;
  target: ChatActivityHostTarget;
  controllerId: string | null;
  generation: string | null;
  sessionId: string;
  epoch: string;
};

export function activityKeyString(key: ChatActivityKey): string {
  return JSON.stringify([
    key.serverId,
    key.tenantId,
    key.roomId,
    key.agentId,
    key.target,
    key.controllerId,
    key.generation,
    key.sessionId,
    key.epoch,
  ]);
}
