import { agentActual } from '@renderer/features/switch-servers/this-computer-machine';
import type { PlacedManagedAgent } from '@shared/core/embedded-controller/embedded-controller';
import type {
  HostControllerOverview,
  HostControllerProcess,
} from '@shared/core/host-controllers/host-controllers';

export type HostMachineTone = 'neutral' | 'busy' | 'ok' | 'warn' | 'error';

export type HostMachineStatus = { label: string; tone: HostMachineTone; detail: string | null };

type StoppedProcess = Extract<HostControllerProcess, { kind: 'stopped' }>;

/**
 * Why a stopped controller is not running. The supervisor's word for its
 * state is never repeated as is: a process the host reports stopped is not
 * running, whatever word was left behind.
 */
function stoppedReason(process: StoppedProcess): string {
  if (process.code === 3) return 'Switch removed this host as a machine.';
  if (process.code === 2) return 'It stopped on a configuration error.';
  if (process.code === 4) return 'Another copy of this controller took over.';
  switch (process.state) {
    case 'never-started':
      return 'It has not been started on this host.';
    case 'stopped':
      return 'It was stopped.';
    case 'exited':
      return process.code === null ? 'It exited.' : `It exited with code ${process.code}.`;
    case 'failed':
      return 'systemd reports that it failed.';
    case 'inactive':
      return 'systemd reports it inactive.';
    case 'gone':
    case 'running':
    case 'restarting':
    case 'active':
    case 'activating':
    case 'reloading':
      return 'Its process is gone without saying why: the host may have restarted, or the process was killed.';
    default:
      return `Its supervisor reports it ${process.state}.`;
  }
}

/** One line of state for "This host as a machine". */
export function hostMachineStatus(overview: HostControllerOverview): HostMachineStatus {
  const { phase, enrollment, process, remote } = overview;
  if (phase.kind === 'installing')
    return { label: 'Setting up…', tone: 'busy', detail: phase.step };
  if (phase.kind === 'removing')
    return {
      label: 'Turning off…',
      tone: 'busy',
      detail: 'Removing the host from Switch and stopping its managed agents.',
    };
  if (!enrollment) {
    if (phase.kind === 'error') return { label: 'Off', tone: 'error', detail: phase.message };
    return { label: 'Off', tone: 'neutral', detail: null };
  }
  const failed = phase.kind === 'error' ? phase.message : null;
  if (hostUnknownToServer(overview)) {
    const why = `Switch no longer knows ${overview.sshHost} as a machine (its data was reset or restored, or the machine was deleted), so its controller cannot sign in. Enroll it again.`;
    return {
      label: 'Unknown to Switch',
      tone: 'error',
      detail: overview.movedAgents.length
        ? `${why} ${overview.movedAgents.join(', ')}, moved here from this Console, then need Stop managing, and can be moved again.`
        : why,
    };
  }
  if (process?.kind === 'unknown')
    return {
      label: 'Unknown',
      tone: 'warn',
      detail: `Console cannot tell whether the controller runs: ${process.reason}`,
    };
  if (process?.kind === 'stopped')
    return {
      label: process.code === 3 ? 'Removed' : 'Stopped',
      tone: 'error',
      detail: [
        failed,
        `The controller is not running. ${stoppedReason(process)}`,
        process.log ? `The last lines it logged:\n${process.log}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  if (remote?.kind === 'error')
    return {
      label: 'Running',
      tone: 'warn',
      detail: `The controller runs, but Switch could not be asked how it sees it: ${remote.message}`,
    };
  if (remote?.kind === 'unavailable')
    return {
      label: 'Disconnected',
      tone: 'warn',
      detail: 'This server no longer has agent management turned on.',
    };
  const state = remote?.kind === 'ok' ? (remote.controller?.state ?? null) : null;
  if (remote?.kind === 'ok' && state !== 'online')
    return {
      label: state === 'revoked' ? 'Removed' : 'Disconnected',
      tone: state === 'revoked' ? 'error' : 'warn',
      detail:
        state === 'revoked'
          ? 'Switch has removed this host; its controller is stopping its agents.'
          : 'The controller runs but has not reached Switch recently. It keeps trying.',
    };
  return { label: 'Running', tone: failed ? 'warn' : 'ok', detail: failed };
}

/** How the controller is kept running, said for a person. */
export function supervisionNote(overview: HostControllerOverview): string | null {
  const supervision = overview.enrollment?.supervision;
  if (supervision === 'systemd')
    return 'A systemd user unit keeps it running, also after the host restarts.';
  if (supervision === 'detached')
    return 'A background process keeps it running while the host is up (this host has no lingering systemd user session). After the host restarts, press Start again.';
  return null;
}

/**
 * Why the toggle cannot be moved now, or null when it can. Turning it on needs
 * a workspace and a server with agent management; turning it off needs the
 * agents moved from this Console brought back first.
 */
export function hostToggleBlocker(overview: HostControllerOverview): string | null {
  const { phase, enrollment, remote } = overview;
  if (phase.kind === 'installing' || phase.kind === 'removing') return 'Working…';
  if (enrollment) {
    if (overview.movedAgents.length)
      return `Bring back ${overview.movedAgents.join(', ')} before turning it off.`;
    return null;
  }
  if (remote === null) return 'Open a workspace on this server to add the host to it.';
  if (remote.kind === 'unavailable')
    return 'This server does not have agent management turned on, so it cannot place agents on machines.';
  if (remote.kind === 'error') return `Switch could not be asked: ${remote.message}`;
  return null;
}

/** Start again is offered when the controller is enrolled and not running. */
export function canRestartHost(overview: HostControllerOverview): boolean {
  return (
    overview.enrollment !== null &&
    overview.phase.kind !== 'installing' &&
    overview.phase.kind !== 'removing' &&
    overview.process?.kind === 'stopped' &&
    overview.process.code !== 3
  );
}

export type HostAgentActual = { label: string; tone: HostMachineTone; detail: string | null };

/**
 * What a managed agent placed on the host is doing. The controller's last
 * report holds only while the controller runs: with it stopped, or with
 * Console unable to tell, nothing on the host runs the agent, whatever it
 * reported before.
 */
export function hostAgentActual(
  overview: HostControllerOverview,
  agent: PlacedManagedAgent
): HostAgentActual {
  const process = overview.process;
  if (process?.kind === 'stopped')
    return {
      label: 'not running',
      tone: agent.desiredState === 'running' ? 'warn' : 'neutral',
      detail: 'the controller is not running',
    };
  if (process?.kind === 'unknown')
    return {
      label: 'unknown',
      tone: 'warn',
      detail: 'Console cannot tell whether the controller runs',
    };
  return { ...agentActual(agent), detail: agent.actual?.detail ?? null };
}

/**
 * What the card's state is, for telling whether a failure shown on it still
 * describes it: the phase, the enrollment, whether the controller runs (and
 * how it stopped) and the agents moved here.
 */
export function hostStateKey(overview: HostControllerOverview): string {
  const { process } = overview;
  return JSON.stringify([
    overview.phase.kind,
    overview.enrollment?.controllerId ?? null,
    process?.kind ?? null,
    process?.kind === 'stopped' ? process.code : null,
    overview.movedAgents,
  ]);
}

/** Whether a failed action's message is already on the card, as the failure Console keeps for the host. */
export function failureAlreadyShown(overview: HostControllerOverview, message: string): boolean {
  return overview.phase.kind === 'error' && overview.phase.message.trim() === message.trim();
}

/** Switch answered, and does not list the machine this host is enrolled as. */
export function hostUnknownToServer(overview: HostControllerOverview): boolean {
  return (
    overview.enrollment !== null &&
    overview.phase.kind !== 'installing' &&
    overview.phase.kind !== 'removing' &&
    overview.remote?.kind === 'ok' &&
    overview.remote.controller === null
  );
}
