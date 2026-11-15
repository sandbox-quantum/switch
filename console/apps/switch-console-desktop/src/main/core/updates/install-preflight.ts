/**
 * Whether macOS runs this copy of the app from a translocated path.
 *
 * Gatekeeper runs a downloaded app that was not moved out of its download
 * folder from a randomised read-only mount. Squirrel.Mac cannot replace a
 * bundle there, and the failure comes after the app has handed over.
 *
 * Ownership and write access are not checked: Squirrel.Mac asks for an admin
 * password when it cannot write the bundle, and the launch after a handover
 * reports an install that still failed.
 */
export function isTranslocated(executablePath: string): boolean {
  return executablePath.includes('/AppTranslocation/');
}
