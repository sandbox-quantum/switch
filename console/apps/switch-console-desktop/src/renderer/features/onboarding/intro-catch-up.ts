import type { ShellShape } from '@renderer/app/shell-shape';

/**
 * Whether the first-run intro plays over the app, once, for an install that
 * was set up before the intro existed and so went straight past Welcome.
 *
 * A fresh install plays it in front of Welcome and is marked as having seen it
 * there, so it never gets here a second time. A flow on screen — a first run
 * or a rehearsal, even one stepped out of into Settings — plays its own, and
 * the two must never both be up.
 */
export function shouldCatchUpIntro({
  shape,
  loaded,
  installIsEmpty,
  onboardingInProgress,
  onboardingEnabled,
  introSeen,
}: {
  /** What the window holds otherwise; the intro only ever stands in for the workspace. */
  shape: ShellShape;
  /**
   * Whether the server list has been read. The workspace can be drawn before
   * it has — Settings needs no server — and until then an install with servers
   * cannot be told from a fresh one.
   */
  loaded: boolean;
  /** Whether this install holds nothing yet: such an install sees the intro at Welcome instead. */
  installIsEmpty: boolean;
  /** Whether the first-run flow has been started and not yet finished. */
  onboardingInProgress: boolean;
  /** Whether this build has the first-run pages, which the intro belongs to. */
  onboardingEnabled: boolean;
  /** Whether this install has played the intro before, anywhere. */
  introSeen: boolean;
}): boolean {
  if (introSeen || !onboardingEnabled) return false;
  if (shape !== 'workspace' || !loaded) return false;
  if (onboardingInProgress) return false;
  return !installIsEmpty;
}
