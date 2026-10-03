import type {
  EmbeddedControllerOverview,
  PlacedManagedAgent,
} from '@shared/core/embedded-controller/embedded-controller';

export type MachineStatusTone = 'neutral' | 'busy' | 'ok' | 'warn' | 'error';

/** One line of state for "This computer as a machine": off, enrolling, running, disconnected, removed or error. */
export type MachineStatus = {
  label: string;
  tone: MachineStatusTone;
  detail: string | null;
};

const REMOVED_DETAIL =
  'This computer was removed from Switch. Its managed agents were stopped. Turn it on again to add it back as a new machine.';

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function machineStatus(overview: EmbeddedControllerOverview): MachineStatus {
  const { phase, remote } = overview;
  switch (phase.kind) {
    case 'off':
      return { label: 'Off', tone: 'neutral', detail: null };
    case 'enrolling':
      return { label: 'Adding this computer…', tone: 'busy', detail: null };
    case 'stopping':
      return {
        label: 'Turning off…',
        tone: 'busy',
        detail: 'Removing this computer from Switch and stopping its managed agents.',
      };
    case 'removed':
      return { label: 'Removed', tone: 'error', detail: REMOVED_DETAIL };
    case 'taken_over':
      return {
        label: 'Error',
        tone: 'error',
        detail:
          'Another copy of this computer’s controller connected to Switch and took over, so this one stopped. Start it again only once that copy has stopped, or the two take turns.',
      };
    case 'error':
      return { label: 'Error', tone: 'error', detail: phase.message };
    case 'restarting':
      return {
        label: 'Disconnected',
        tone: 'warn',
        detail: `The controller stopped (${phase.lastExit}). Starting it again at ${clock(phase.retryAt)}.`,
      };
    case 'running': {
      if (remote?.kind === 'error')
        return {
          label: 'Running',
          tone: 'warn',
          detail: `The controller is running, but Switch could not be asked how it sees it: ${remote.message}`,
        };
      if (remote?.kind === 'unavailable')
        return {
          label: 'Disconnected',
          tone: 'warn',
          detail: 'This server no longer has agent management turned on.',
        };
      if (remote?.kind !== 'ok') return { label: 'Running', tone: 'ok', detail: null };
      const state = remote.controller?.state ?? null;
      if (state === 'online') return { label: 'Running', tone: 'ok', detail: null };
      if (state === 'revoked')
        return {
          label: 'Removed',
          tone: 'error',
          detail: 'Switch has removed this computer; its controller is stopping its agents.',
        };
      return {
        label: 'Disconnected',
        tone: 'warn',
        detail:
          state === null
            ? 'Switch does not list this computer’s controller.'
            : 'The controller is running but has not reached Switch recently. It keeps trying.',
      };
    }
  }
}

/**
 * Why the toggle cannot be moved now, or null when it can. Turning it on needs
 * a computer that can run the controller, a workspace to enroll in and a
 * server with agent management; turning it off needs only that nothing else
 * is in flight.
 */
export function toggleBlocker(overview: EmbeddedControllerOverview): string | null {
  const { phase, enrollment, remote } = overview;
  if (phase.kind === 'enrolling' || phase.kind === 'stopping') return 'Working…';
  if (enrollment) return null;
  if (overview.unsupportedReason) return overview.unsupportedReason;
  if (remote === null) return 'Open a workspace on this server to add this computer to it.';
  if (remote.kind === 'unavailable')
    return 'This server does not have agent management turned on, so it cannot place agents on machines.';
  if (remote.kind === 'error') return `Switch could not be asked: ${remote.message}`;
  return null;
}

/** The toggle reads on while enrolled, or while enrolling. */
export function toggleChecked(overview: EmbeddedControllerOverview): boolean {
  return overview.enrollment !== null || overview.phase.kind === 'enrolling';
}

/** What a placed agent is doing, as its controller last reported it. */
export function agentActual(agent: PlacedManagedAgent): { label: string; tone: MachineStatusTone } {
  const actual = agent.actual;
  if (!actual) return { label: 'Not reported yet', tone: 'neutral' };
  const reason = actual.reason ? ` (${actual.reason.replaceAll('_', ' ')})` : '';
  const tone: MachineStatusTone =
    actual.process === 'failed' || actual.process === 'crashed'
      ? 'error'
      : actual.process === 'running'
        ? actual.attached
          ? 'ok'
          : 'warn'
        : 'neutral';
  const attached = actual.process === 'running' && !actual.attached ? ', not attached' : '';
  return { label: `${actual.process}${attached}${reason}`, tone };
}

/** Restart is offered for the states the controller is not restarted from on its own. */
export function canStartAgain(overview: EmbeddedControllerOverview): boolean {
  return (
    overview.enrollment !== null &&
    (overview.phase.kind === 'taken_over' || overview.phase.kind === 'error')
  );
}
