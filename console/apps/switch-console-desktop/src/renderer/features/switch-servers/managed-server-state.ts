import type {
  LocalServerPhase,
  ManagedServerUpgrade,
  SwitchVersionDrift,
} from '@shared/core/managed-switch-server/managed-switch-server';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { localServerStore } from './local-server-store';
import { remoteServerStore } from './remote-server-store';

/**
 * The five ways a managed server can be, as a colour:
 *
 * - `running` — everything works.
 * - `working` — starting, stopping, updating, or another Console is busy with it.
 * - `attention` — running, but something is waiting on you, such as an update.
 * - `stopped` — not running.
 * - `failed` — failed to start or update, or can't be managed from here.
 */
export type ManagedTone = 'running' | 'working' | 'attention' | 'stopped' | 'failed';

/** Why a server has its tone. The page and the banner word each one. */
export type ManagedReason =
  | 'running'
  | 'starting'
  | 'stopping'
  | 'updating'
  | 'waiting'
  | 'busy'
  | 'update-ready'
  | 'version-mismatch'
  | 'version-unknown'
  | 'stopped'
  | 'host-unreachable'
  | 'update-failed'
  | 'downgrade'
  | 'docker-unavailable'
  | 'start-failed'
  | 'stop-failed'
  | 'reset-failed';

const REASON: Record<ManagedReason, { tone: ManagedTone; label: string; answering: boolean }> = {
  running: { tone: 'running', label: 'Running', answering: true },
  starting: { tone: 'working', label: 'Starting', answering: false },
  stopping: { tone: 'working', label: 'Stopping', answering: false },
  updating: { tone: 'working', label: 'Updating', answering: false },
  // Answering is decided by the phase: another Console may hold a running server.
  waiting: { tone: 'working', label: 'Waiting', answering: false },
  busy: { tone: 'working', label: 'Working', answering: false },
  'update-ready': { tone: 'attention', label: 'Update ready', answering: true },
  'version-mismatch': { tone: 'attention', label: 'Version mismatch', answering: true },
  'version-unknown': { tone: 'attention', label: 'Version unknown', answering: true },
  stopped: { tone: 'stopped', label: 'Not running', answering: false },
  'host-unreachable': { tone: 'failed', label: 'Host unreachable', answering: false },
  'update-failed': { tone: 'failed', label: 'Update failed', answering: false },
  downgrade: { tone: 'failed', label: 'Newer than this app', answering: false },
  'docker-unavailable': { tone: 'failed', label: 'Docker not running', answering: false },
  'start-failed': { tone: 'failed', label: 'Failed to start', answering: false },
  'stop-failed': { tone: 'failed', label: "Couldn't stop", answering: false },
  'reset-failed': { tone: 'failed', label: 'Reset failed', answering: false },
};

export type ManagedServerState = {
  tone: ManagedTone;
  reason: ManagedReason;
  /** The words on the server page's pill. Never shown in the switcher. */
  label: string;
  /**
   * Whether the server can answer. A workspace on a server that cannot is
   * frozen; one that needs attention still works, so it is not.
   */
  answering: boolean;
  /**
   * False until the server's state has been read since launch. A stack that
   * has not been looked at yet is not known to be stopped, so nothing is
   * frozen or coloured on its account.
   */
  known: boolean;
};

export type ManagedStateInput = {
  phase: LocalServerPhase;
  checked: boolean;
  /** An action this window asked for is in flight. */
  busy: boolean;
  hostBlocked: boolean;
  upgrade: ManagedServerUpgrade | null;
  drift: SwitchVersionDrift | null;
  /** Waiting for another Console to finish with the server. */
  waiting: boolean;
  dockerUnavailable: boolean;
  /** What broke, when an error is from a stop or a reset rather than a start. */
  failedTo: 'stop' | 'reset' | null;
};

function stateFor(reason: ManagedReason, known: boolean): ManagedServerState {
  return { reason, ...REASON[reason], known };
}

function reasonFor(input: ManagedStateInput): ManagedReason {
  const { phase, upgrade, drift } = input;
  if (input.hostBlocked) return 'host-unreachable';
  if (upgrade?.state === 'updating') return 'updating';
  if (phase === 'starting') return 'starting';
  if (phase === 'stopping') return 'stopping';
  if (input.waiting) return 'waiting';
  if (input.busy) return 'busy';
  if (phase === 'error') {
    if (input.failedTo === 'stop') return 'stop-failed';
    if (input.failedTo === 'reset') return 'reset-failed';
    if (drift?.direction === 'downgrade') return 'downgrade';
    if (upgrade?.state === 'failed') return 'update-failed';
    if (input.dockerUnavailable) return 'docker-unavailable';
    return 'start-failed';
  }
  if (upgrade?.state === 'failed') return 'update-failed';
  if (phase === 'running') {
    if (upgrade?.state === 'held') return 'update-ready';
    if (drift?.direction === 'unknown') return 'version-mismatch';
    if (drift?.direction === 'unreadable') return 'version-unknown';
    return 'running';
  }
  return 'stopped';
}

export function deriveManagedState(input: ManagedStateInput): ManagedServerState {
  const reason = reasonFor(input);
  const state = stateFor(reason, reason !== 'stopped' || input.checked);
  return reason === 'waiting' ? { ...state, answering: input.phase === 'running' } : state;
}

/** The state of a server this Console runs, or null for any other server. */
export function managedServerState(server: SwitchServer): ManagedServerState | null {
  if (!server.managed) return null;
  if (server.managementKind === 'remote') {
    if (!server.sshHost) return null;
    const host = server.sshHost;
    const status = remoteServerStore.statusFor(host);
    const docker = remoteServerStore.dockerFor(host);
    return deriveManagedState({
      phase: status.phase,
      checked: status.checked,
      busy: remoteServerStore.isBusy(host),
      hostBlocked: remoteServerStore.isHostBlocked(host),
      upgrade: status.upgrade,
      drift: status.drift,
      waiting: status.waitingFor !== null,
      dockerUnavailable: docker !== null && !docker.available,
      failedTo: status.failedTo,
    });
  }
  const status = localServerStore.status;
  if (!status) return stateFor('stopped', false);
  const docker = localServerStore.docker;
  return deriveManagedState({
    phase: status.phase,
    checked: status.checked,
    busy: localServerStore.busy,
    hostBlocked: false,
    upgrade: status.upgrade,
    drift: status.drift,
    waiting: false,
    dockerUnavailable: docker !== null && !docker.available,
    failedTo: status.failedTo,
  });
}

/** How the parts of a frozen workspace that can't be used are shown: dimmed,
 * and out of reach of the pointer. */
export const FROZEN = 'pointer-events-none select-none opacity-[.38]';

/** Whether a workspace on `server` should be frozen: it is managed here, its
 * state is known, and it cannot answer. */
export function isFrozenServer(server: SwitchServer): boolean {
  const state = managedServerState(server);
  return state !== null && state.known && !state.answering;
}
