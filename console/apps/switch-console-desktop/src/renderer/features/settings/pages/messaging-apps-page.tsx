import { MessagingAppsCard } from '@renderer/features/switch-servers/MessagingAppsCard';
import { PageHeader } from '@renderer/lib/components/page-header';
import { OnSignedInServer } from './settings-server';

/** Your accounts in the workspace's messaging apps, so your agents know you there. */
export function MessagingAppsSettingsPage() {
  return (
    <div className="space-y-8 pb-10">
      <PageHeader
        sticky
        title="Messaging apps"
        description="Link your account in each app so your agents recognise you there."
      />
      <OnSignedInServer>
        {({ server }) => <MessagingAppsCard serverId={server.id} personal />}
      </OnSignedInServer>
    </div>
  );
}
