/** Which of the window's shapes what this install holds implies. */
export type ShellShape = 'loading' | 'failed' | 'onboarding' | 'workspace';

/**
 * Decide what fills the window from what is known about this install.
 *
 * Separated from the component because the wrong answer here is not a layout
 * bug — `onboarding` shown to someone who has an install hides the whole of it
 * behind a first-run page, and `workspace` shown on a fresh one is a sidebar
 * listing nothing. The inputs are easy to get the wrong way round, so they are
 * decided in one place that can be exercised directly.
 *
 * `loaded` is what separates an empty install from one that has not been asked
 * yet; both leave `installIsEmpty` false.
 */
export function shellShape({
  loaded,
  listError,
  installIsEmpty,
  viewWorksWithoutServer,
  onboardingInProgress,
}: {
  loaded: boolean;
  /**
   * The list read's own failure, not the store's shared error slot — every
   * action in that store writes the shared one, and a rename that went wrong
   * is not a reason to put the whole window into its failure shape.
   *
   * It must also outlive a retry rather than being cleared as one starts:
   * otherwise pressing "Try again" takes the failure page off screen, and the
   * button with it, for as long as the retry runs.
   */
  listError: string | null;
  /**
   * Whether this install holds nothing at all — no server, no location, no
   * agent.
   *
   * Not "has no server". Removing a server keeps its agents and says so in the
   * confirmation, and the sessions running in them carry on; reading that as a
   * fresh install would hide all of it behind a welcome page, permanently and
   * across relaunches.
   */
  installIsEmpty: boolean;
  /**
   * Whether what is on screen can be drawn with no server behind it.
   *
   * The way out of the onboarding page for the views that do not describe a
   * server. Without one, ⌘, and the Preferences menu item do nothing on a
   * fresh install. Each view says this about itself rather than being named
   * here, so the next one of the same kind is not missed.
   */
  viewWorksWithoutServer: boolean;
  /** Whether the first-run flow has been started and not yet finished. */
  onboardingInProgress: boolean;
}): ShellShape {
  // Checked before the read, not after. Such a view needs nothing from this
  // install to draw, and a first read that failed is exactly when Settings —
  // its logs, its database — is where the user has to be able to get to.
  if (viewWorksWithoutServer) return 'workspace';
  // A failed read that nevertheless loaded once keeps the workspace: the list
  // in hand is still the list, and a later refresh failing is not a reason to
  // take the app away.
  if (!loaded) return listError === null ? 'loading' : 'failed';
  // A flow in progress outranks what the install holds, because the flow is
  // what changes it: the server is added several pages before the user has
  // signed in to it, and going by the contents alone would throw them out of
  // the flow at the moment it half-succeeded.
  if (onboardingInProgress) return 'onboarding';
  return installIsEmpty ? 'onboarding' : 'workspace';
}
