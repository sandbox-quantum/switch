import { onboardingStore } from '@renderer/features/onboarding/onboarding-store';
import { showDevTools } from '@renderer/lib/dev-tools';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import { BUILD_FEATURE_FLAGS } from '@shared/core/feature-flags/feature-flags';
import { SettingRow } from './SettingRow';

/**
 * Walk through the first-run pages again on an install that already has
 * servers, to test them. Dev and canary builds only.
 *
 * It leaves Settings for the home view on the way, because Settings is drawn
 * even when there is no server and so would stay on screen over the flow.
 */
export function ReplayOnboardingRow() {
  const { navigate } = useNavigate();
  if (!showDevTools() || !BUILD_FEATURE_FLAGS.onboarding) return null;
  return (
    <SettingRow
      title="Replay first-run pages"
      description="Go through the welcome and add-a-server pages as a fresh install would. Your servers and agents stay as they are. Dev and canary builds only."
      control={
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            onboardingStore.rehearse();
            navigate('home');
          }}
        >
          Replay
        </Button>
      }
    />
  );
}
