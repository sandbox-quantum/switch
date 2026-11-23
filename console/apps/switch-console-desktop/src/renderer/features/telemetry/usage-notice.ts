/**
 * Whether the usage-data notice is still owed: never shown, or not read yet.
 * The first-run pages show it to a new install; an install that already held
 * servers when it updated to a build with those pages never saw them, and is
 * shown this prompt over its workspace instead.
 */
export function usageNoticeOwed(telemetry: { askedAt: number | null } | undefined): boolean {
  return telemetry === undefined || telemetry.askedAt === null;
}

/**
 * Whether the workspace shows the usage-data notice itself: only to an
 * install that already holds servers and is not in the first run, whose pages
 * carry the notice. A new install can reach the workspace before then (Settings
 * opens without a server), and must not be shown it there first.
 */
export function workspaceShowsUsageNotice(state: {
  onboardingEnabled: boolean;
  loaded: boolean;
  installIsEmpty: boolean;
  onboardingInProgress: boolean;
}): boolean {
  return (
    state.onboardingEnabled && state.loaded && !state.installIsEmpty && !state.onboardingInProgress
  );
}
