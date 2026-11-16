import { toast } from 'sonner';
import { onboardingStore } from '@renderer/features/onboarding/onboarding-store';
import { showDevTools } from '@renderer/lib/dev-tools';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { SettingRow } from './SettingRow';

async function restartAsFreshInstall(): Promise<void> {
  try {
    const result = await rpc.app.replayAsFreshInstall();
    if (!result.success) throw new Error(result.error);
  } catch (cause) {
    const { headline, detail } = describeFailure(cause, 'Could not restart as a fresh install.');
    toast.error(headline, detail ? { description: detail } : undefined);
  }
}

/** Ask first, then restart the app on an empty data folder; a failure is shown as a toast. */
export function useConfirmFreshInstall(): () => void {
  const showConfirm = useShowModal('confirmActionModal');
  return () =>
    showConfirm({
      title: 'Restart as a fresh install?',
      description:
        'The app quits and restarts with an empty data folder. Running sessions stop. Your real data comes back on the next normal launch.',
      confirmLabel: 'Restart',
      onSuccess: () => void restartAsFreshInstall(),
    });
}

/**
 * Walk through the first-run pages again, to test them. Dev and canary builds
 * only. "Pages only" replays them over this install; "Fresh install" restarts
 * the app on an empty data folder.
 *
 * "Pages only" leaves Settings for the home on the way, because Settings
 * is drawn even when there is no server and so would stay on screen over the flow.
 */
export function ReplayOnboardingRow() {
  const { navigate } = useNavigate();
  const confirmFreshInstall = useConfirmFreshInstall();
  if (!showDevTools()) return null;
  return (
    <SettingRow
      title="Replay onboarding"
      description={
        <>
          Pages only keeps your servers and agents. Fresh install restarts with an empty data
          folder; your real data comes back on the next normal launch, and ~/.switch and your Claude
          and Codex settings stay. Dev and canary builds only.
        </>
      }
      control={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onboardingStore.rehearse();
              navigate('noServer');
            }}
          >
            Pages only
          </Button>
          <Button variant="outline" size="sm" onClick={confirmFreshInstall}>
            Fresh install
          </Button>
        </>
      }
    />
  );
}
