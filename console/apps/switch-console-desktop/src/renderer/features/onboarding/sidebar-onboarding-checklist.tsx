import { observer } from 'mobx-react-lite';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { appState } from '@renderer/lib/stores/app-state';
import { BUILD_FEATURE_FLAGS } from '@shared/core/feature-flags/feature-flags';
import { OnboardingChecklistPanel } from './onboarding-checklist';
import { useOnboardingChecklist } from './use-onboarding-checklist';

/**
 * The sidebar's setup checklist, or nothing at all.
 *
 * It hides itself once the user dismisses it, and — separately — once every
 * step is done AND they have collapsed it, so a finished checklist stops taking
 * sidebar space without vanishing the moment the last step completes (seeing it
 * turn green is the point of having it).
 */
export const SidebarOnboardingChecklist = observer(function SidebarOnboardingChecklist() {
  const { value, isLoading } = useAppSettingsKey('onboarding');
  const { steps, complete, startStep, dismiss } = useOnboardingChecklist();

  // Render nothing until the setting is known, rather than flashing a checklist
  // at someone who dismissed it three launches ago.
  // The first-run flow ends with switch-buddy, which takes the checklist's
  // place: it does those steps with the person rather than listing them.
  if (BUILD_FEATURE_FLAGS.onboarding || isLoading || !value?.showChecklist) return null;

  return (
    <OnboardingChecklistPanel
      steps={steps}
      complete={complete}
      collapsed={appState.sidebar.onboardingChecklistCollapsed}
      onStart={startStep}
      onToggleCollapsed={() => appState.sidebar.toggleOnboardingChecklistCollapsed()}
      onDismiss={dismiss}
    />
  );
});
