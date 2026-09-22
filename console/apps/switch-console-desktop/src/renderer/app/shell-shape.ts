/** Which of the window's shapes the server list implies. */
export type ShellShape = 'loading' | 'failed' | 'onboarding' | 'workspace';

/**
 * Decide what fills the window from what is known about the server list.
 *
 * Separated from the component because the wrong answer here is not a layout
 * bug — `onboarding` shown to someone who has servers hides their whole install
 * behind a first-run page, and `workspace` shown on a fresh one is a sidebar
 * listing nothing. The inputs are easy to get the wrong way round, so they are
 * decided in one place that can be exercised directly.
 *
 * `loaded` is what separates "no servers" from "not asked yet"; both leave
 * `serverCount` at 0.
 */
export function shellShape({
  loaded,
  listError,
  serverCount,
  viewWorksWithoutServer,
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
  serverCount: number;
  /**
   * Whether what is on screen can be drawn with no server behind it.
   *
   * The way out of the onboarding page for the views that do not describe a
   * server. Without one, ⌘, and the Preferences menu item do nothing on a
   * fresh install. Each view says this about itself rather than being named
   * here, so the next one of the same kind is not missed.
   */
  viewWorksWithoutServer: boolean;
}): ShellShape {
  // A failed read that nevertheless loaded once keeps the workspace: the list
  // in hand is still the list, and a later refresh failing is not a reason to
  // take the app away.
  if (!loaded) return listError === null ? 'loading' : 'failed';
  // Such a view outranks onboarding. It is a view, so only the workspace can
  // draw it, and the onboarding page carries no chrome of its own — holding the
  // window on it would leave every one of them unreachable.
  if (viewWorksWithoutServer) return 'workspace';
  return serverCount === 0 ? 'onboarding' : 'workspace';
}
