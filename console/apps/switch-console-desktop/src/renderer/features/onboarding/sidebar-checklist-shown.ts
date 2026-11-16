import { BUILD_FEATURE_FLAGS } from '@shared/core/feature-flags/feature-flags';

/**
 * Whether this build can show the sidebar's setup checklist at all. The
 * first-run flow ends with switch-buddy, which takes the checklist's place:
 * it does those steps with the person rather than listing them. Where the
 * checklist can't appear, Settings offers no switch for it either.
 */
export function sidebarChecklistCanAppear(): boolean {
  return !BUILD_FEATURE_FLAGS.onboarding;
}
