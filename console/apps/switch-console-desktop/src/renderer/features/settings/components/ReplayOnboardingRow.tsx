import { useState } from 'react';
import { onboardingStore } from '@renderer/features/onboarding/onboarding-store';
import { showDevTools } from '@renderer/lib/dev-tools';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import { SettingRow } from './SettingRow';

/**
 * Walk through the first-run pages again, to test them. Dev and canary builds
 * only. "Pages only" replays them over this install; "Fresh install" restarts
 * the app on an empty data folder.
 *
 * "Pages only" leaves Settings for the home view on the way, because Settings
 * is drawn even when there is no server and so would stay on screen over the flow.
 */
export function ReplayOnboardingRow() {
  const { navigate } = useNavigate();
  const [error, setError] = useState<string | null>(null);
  if (!showDevTools()) return null;
  return (
    <SettingRow
      title="Replay onboarding"
      description={
        <>
          Pages only keeps your servers and agents. Fresh install restarts with an empty data
          folder; your real data comes back on the next normal launch, and ~/.switch and your Claude
          and Codex settings stay. Dev and canary builds only.
          {error && <span className="block text-foreground-destructive">{error}</span>}
        </>
      }
      control={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onboardingStore.rehearse();
              navigate('home');
            }}
          >
            Pages only
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              setError(null);
              const result = await rpc.app.replayAsFreshInstall();
              if (!result.success)
                setError(result.error ?? 'Could not restart as a fresh install.');
            }}
          >
            Fresh install
          </Button>
        </>
      }
    />
  );
}
