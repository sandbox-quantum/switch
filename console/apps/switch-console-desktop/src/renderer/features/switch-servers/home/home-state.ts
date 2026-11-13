import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';

/**
 * What a server's Home shows below its header, besides the error banner,
 * which sits above whatever this is.
 *
 * `stopped` is a server this Console runs that is not running: the workspace
 * banner offers to start it and the page itself shows nothing. `loading` holds
 * until everything the next state depends on is known, so the page never
 * shows one state and then flips to another.
 */
export type HomeState =
  | 'hostUnreachable'
  | 'stopped'
  | 'unreachable'
  | 'signedOut'
  | 'loading'
  | 'connectAi'
  | 'askBuddy';

export type HomeStateInputs = {
  /** The SSH host a remote managed server runs on is blocked. */
  hostBlocked: boolean;
  /** A server this Console runs, and it is not running. */
  stopped: boolean;
  /** The server's gateway could not be reached. */
  unreachable: boolean;
  /** Whether the account is signed in; null while the server's status is not known yet. */
  signedIn: boolean | null;
  /** Whether switch-buddy can chat; null while that is being checked. */
  aiConnected: boolean | null;
  /** Whether what the suggestions are picked from has been read. */
  suggestionsReady: boolean;
};

export function homeState(inputs: HomeStateInputs): HomeState {
  if (inputs.hostBlocked) return 'hostUnreachable';
  if (inputs.stopped) return 'stopped';
  if (inputs.unreachable) return 'unreachable';
  if (inputs.signedIn === null) return 'loading';
  if (!inputs.signedIn) return 'signedOut';
  if (inputs.aiConnected === null) return 'loading';
  if (!inputs.aiConnected) return 'connectAi';
  return inputs.suggestionsReady ? 'askBuddy' : 'loading';
}

/**
 * Whether the buddy's machine can take a message now. A Switch cloud machine
 * is started when it is needed, so being offline does not count against it;
 * any other has to be connected, or the buddy only answers that it is away.
 */
export function reachable(machine: Pick<OwnedMachine, 'state' | 'cloud'>): boolean {
  if (machine.state === 'revoked') return false;
  return machine.cloud || machine.state === 'online';
}
