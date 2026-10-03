import type { HostControllerOverview } from '@shared/core/host-controllers/host-controllers';

export type HostMachineTone = 'neutral' | 'busy' | 'ok' | 'warn' | 'error';

export type HostMachineStatus = { label: string; tone: HostMachineTone; detail: string | null };

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
  if (process?.kind === 'unknown')
    return {
      label: 'Unknown',
      tone: 'warn',
      detail: `Console cannot tell whether the controller runs: ${process.reason}`,
    };
  if (process?.kind === 'stopped') {
    const why =
      process.code === 3
        ? 'Switch removed this host as a machine.'
        : process.code === 2
          ? 'It stopped on a configuration error.'
          : process.code === 4
            ? 'Another copy of this controller took over.'
            : `It is ${process.state}.`;
    return {
      label: process.code === 3 ? 'Removed' : 'Stopped',
      tone: 'error',
      detail: [failed, `The controller is not running. ${why}`, process.log || null]
        .filter(Boolean)
        .join('\n'),
    };
  }
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
          : state === null
            ? 'Switch does not list this host’s controller.'
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
