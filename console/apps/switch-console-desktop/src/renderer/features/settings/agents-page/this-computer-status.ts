import type {
  MachineProvider,
  ThisComputerReport,
} from '@shared/core/managed-agents/managed-agents';

/**
 * What this computer's controller reported about one provider, or null when
 * there is no report to go by and Console's own check stands.
 */
export function reportedProvider(
  report: ThisComputerReport | null | undefined,
  providerId: string
): MachineProvider | null {
  return report?.providers.find((entry) => entry.provider === providerId) ?? null;
}

/**
 * Whether Settings shows a provider as installed: as the controller reported
 * it when it did, else as Console's own dependency check found it.
 */
export function installedHere(
  reported: MachineProvider | null,
  localStatus: string | undefined
): boolean {
  return reported ? reported.problem !== 'not installed' : localStatus === 'available';
}

/** The line Settings shows for a provider the controller reported on, worded as Console's own check words it. */
export function reportedHeadline(reported: MachineProvider): string {
  if (reported.ready) return 'Signed in';
  switch (reported.problem) {
    case 'not installed':
      return 'CLI not installed';
    case 'not logged in':
      return 'Not signed in';
    case 'login expired':
      return 'Sign-in expired';
    case 'login not checked yet':
      return 'Checking sign-in…';
    default:
      return 'Sign-in could not be checked';
  }
}
