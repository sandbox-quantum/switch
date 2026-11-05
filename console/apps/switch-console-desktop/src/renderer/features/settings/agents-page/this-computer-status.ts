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

/**
 * Whether the controller's report and Console's own check disagree on whether
 * a provider is installed. The Installation section under the status still
 * goes by Console's own check, since that is what installs and updates, so
 * when they disagree it says whose answer each one is.
 */
export function installSourcesDiffer(
  reported: MachineProvider | null,
  localStatus: string | undefined
): boolean {
  return (
    reported !== null && installedHere(reported, localStatus) !== installedHere(null, localStatus)
  );
}
