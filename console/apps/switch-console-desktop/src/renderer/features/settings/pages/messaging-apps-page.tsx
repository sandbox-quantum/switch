import { MessagingAppsCard } from '@renderer/features/switch-servers/MessagingAppsCard';
import { PageHeader } from '@renderer/lib/components/page-header';
import { OnSignedInServer } from './settings-server';

/**
 * The workspace's messaging apps: your account in each, so your agents know
 * you there, and for its admins, connecting another and each one's settings.
 */
export function MessagingAppsSettingsPage() {
  return (
    <div className="space-y-8 pb-10">
      <PageHeader
        sticky
        title="Messaging apps"
        description="The messaging apps people reach their agents from. Link your account for your agents to identify you in each messaging app."
      />
      <OnSignedInServer>
        {({ server }) => <MessagingAppsCard serverId={server.id} />}
      </OnSignedInServer>
    </div>
  );
}
