import type { MachineProvider } from '@shared/core/managed-agents/managed-agents';

/**
 * A provider's state as a machine's controller reported it, worded as
 * Console's own check words it on this computer, so Settings and a machine's
 * page say the same thing about the same state.
 */
export function reportedHeadline(reported: MachineProvider): string {
  if (reported.ready) return 'Signed in';
  switch (reported.problem) {
    case 'not installed':
      return 'CLI not installed';
    case 'not logged in':
      return reported.loginHelps ? 'Not signed in' : 'Can’t be used yet';
    case 'login expired':
      return 'Sign-in expired';
    case 'login not checked yet':
      return 'Checking sign-in…';
    default:
      return 'Sign-in could not be checked';
  }
}
