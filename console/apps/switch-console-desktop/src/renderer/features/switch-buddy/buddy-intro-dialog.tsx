import { observer } from 'mobx-react-lite';
import { useRef } from 'react';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { useCurrentViewId, useNavigate } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
import { ONBOARDING_BACKDROP } from '@renderer/lib/ui/wizard-frame';
import { BUILD_FEATURE_FLAGS } from '@shared/core/feature-flags/feature-flags';
import { BuddyAvatar } from './buddy-avatar';
import { firstNameOf, isBuddy } from './buddy-identity';
import { BuddyIntroLines } from './buddy-intro-lines';
import { buddyIntroStore } from './buddy-intro-store';
import { reportBuddyStep } from './buddy-telemetry';

/**
 * switch-buddy, introduced over the app to someone who set Switch up before it
 * existed: on a server that offers it, in a workspace where they have none.
 * It looks like the first run's Meet switch-buddy page, and asks once per
 * workspace: "Meet switch-buddy" opens the buddy's page, where an AI provider
 * is connected to start it, and "Not now" leaves it to the sidebar's entry.
 */
export const BuddyIntroDialog = observer(function BuddyIntroDialog() {
  const { navigate } = useNavigate();
  const meetRef = useRef<HTMLButtonElement>(null);
  const serverId = switchServersStore.activeServerId;
  const flags = useFeatureFlags(serverId);
  const agents = useManagedAgents(serverId);
  const workspaceId = serverId ? workspacesStore.idOnServerInScope(serverId) : null;
  const onBuddyPage = useCurrentViewId() === 'switchBuddy';
  const user = serverId ? (switchServersStore.statusFor(serverId)?.user ?? null) : null;
  if (
    !BUILD_FEATURE_FLAGS.onboarding ||
    onBuddyPage ||
    buddyIntroStore.skippedThisSession ||
    serverId === null ||
    workspaceId === null ||
    !flags.switch_buddy ||
    !flags.agent_management ||
    !agents.data ||
    agents.data.some(isBuddy) ||
    buddyIntroStore.isAnswered(workspaceId)
  )
    return null;

  const notNow = () => {
    buddyIntroStore.answered(workspaceId);
    reportBuddyStep('intro_dismissed', null);
  };
  const meet = () => {
    buddyIntroStore.answered(workspaceId);
    reportBuddyStep('intro_opened', null);
    navigate('switchBuddy', { serverId });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && notNow()}>
      <DialogContent
        aria-labelledby="buddy-intro-heading"
        initialFocus={meetRef}
        className="sm:max-w-[560px]"
        style={{ backgroundImage: ONBOARDING_BACKDROP }}
      >
        <div className="flex flex-col gap-6 overflow-y-auto px-8 pt-10 pb-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <BuddyAvatar size={72} shape="tile" />
            <h2 id="buddy-intro-heading" className="mt-2 text-2xl font-semibold">
              Meet switch-buddy
            </h2>
            <p className="text-sm text-foreground-muted">Your first AI assistant in Switch</p>
          </div>
          <BuddyIntroLines firstName={firstNameOf(user?.name)} />
        </div>
        <div className="flex justify-center gap-2 px-8 pt-2 pb-8">
          <Button variant="ghost" onClick={notNow}>
            Not now
          </Button>
          <Button ref={meetRef} onClick={meet}>
            Meet switch-buddy
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
});
