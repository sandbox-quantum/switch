/**
 * Whether the installed connector plugin's currency is *unknowable*, as opposed
 * to current.
 *
 * `updateAvailable: false` conflates the two: it is what you get both when the
 * advertised version is older-or-equal and when there is no advertised version
 * to compare against at all. The second case is real — Codex's marketplace
 * listing carries no plugin versions, so the remote driver has nothing to read —
 * and a caller that renders it as "up to date" asserts something it never
 * checked. Branch on this to disclose the difference instead.
 *
 * Structural parameter rather than the main-process `SwitchSetupStatus`, so the
 * renderer can share the one definition.
 */
export function updateCheckUnavailable(status: {
  supported: boolean;
  installed: boolean;
  latestVersion: string | null;
}): boolean {
  return status.supported && status.installed && status.latestVersion === null;
}
