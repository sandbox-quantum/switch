import { observer } from 'mobx-react-lite';
import { motion } from 'motion/react';
import { OnboardingChecklistCard } from '@renderer/features/onboarding/onboarding-checklist';
import { useOnboardingChecklist } from '@renderer/features/onboarding/use-onboarding-checklist';
import { WelcomeFooter, WelcomeLearnMore } from '@renderer/features/onboarding/welcome-learn-more';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { SwitchConsoleAppIcon } from '@renderer/lib/switch-console-app-icon';

const TAGLINE = 'A platform-agnostic framework to bring humans and agents together.';

/**
 * The welcome screen (CHOO-2022).
 *
 * It used to be the logo and a single "Add Switch agent" action, which said
 * nothing about what the app was or what setting it up involved. It now carries
 * the same setup checklist as the sidebar — so the main pane answers "what do I
 * do first" instead of leaving it to the one action that happened to be there.
 *
 * The checklist here cannot be collapsed — there is no space to reclaim on a
 * screen this empty — but it can be dismissed, and does so through the same
 * setting as the sidebar's, so it goes away everywhere at once and comes back
 * from Settings → General.
 */
export const HomeMainPanel = observer(function HomeMainPanel() {
  const { steps, complete, startStep } = useOnboardingChecklist();
  const {
    value: onboarding,
    update: updateOnboarding,
    isLoading,
  } = useAppSettingsKey('onboarding');
  // Until the setting has loaded there is no honest answer, and guessing "show"
  // flashes the checklist at someone who dismissed it launches ago.
  const showChecklist = !isLoading && onboarding?.showChecklist === true;

  return (
    // Home registers no TitlebarSlot, so without a drag region here the whole
    // main pane is dead for moving the window and only the sidebar's
    // SidebarSpace strip drags it. The surface is empty, so it is all drag —
    // any interactive control added below must opt out with `no-drag`.
    <motion.div
      className="flex h-full flex-col overflow-y-auto bg-background text-foreground [-webkit-app-region:drag]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >
      <div className="container mx-auto flex min-h-full max-w-2xl flex-1 flex-col justify-center px-8 py-10">
        <div className="flex flex-col items-center gap-4">
          <SwitchConsoleAppIcon size={64} className="rounded-2xl" />
          <p className="max-w-sm text-center text-base text-foreground-muted">{TAGLINE}</p>
        </div>
        <div className="mt-8 flex w-full flex-col gap-4 [-webkit-app-region:no-drag]">
          {showChecklist && (
            <OnboardingChecklistCard
              steps={steps}
              complete={complete}
              onStart={startStep}
              onDismiss={() => updateOnboarding({ showChecklist: false })}
            />
          )}
          <WelcomeLearnMore />
          <WelcomeFooter />
        </div>
      </div>
    </motion.div>
  );
});

export const homeView = {
  MainPanel: HomeMainPanel,
};
