import { observer } from 'mobx-react-lite';
import React from 'react';
import { MigrationSettingsPage } from '@renderer/features/agent-migration/migration-settings-page';
import { DevicesSettingsPage } from '@renderer/features/machines/devices-settings-page';
import { RemoteHostsSettingsPage } from '@renderer/features/remote-hosts/views/remote-hosts-view';
import { openServerPage } from '@renderer/features/switch-servers/open-server-page';
import { servesWebGateway } from '@renderer/features/switch-servers/server-gateway';
import { PageHeader } from '@renderer/lib/components/page-header';
import { PageContent, PageLayout, PageSidebarSections } from '@renderer/lib/components/page-layout';
import { useAnyServerFeatureFlag } from '@renderer/lib/hooks/useFeatureFlags';
import { openExternalUrl } from '@renderer/lib/open-external';
import { dashboardOrigin } from '@shared/core/switch-servers/switch-servers';
import { SWITCH_CONSOLE_DOCS_URL } from '@shared/urls';
import { AgentsSettingsPage } from '../agents-page/AgentsSettingsPage';
import { AccountSettingsPage } from '../pages/account-page';
import { ApiKeysSettingsPage } from '../pages/api-keys-page';
import { MessagingAppsSettingsPage } from '../pages/messaging-apps-page';
import { settingsServer } from '../pages/settings-server';
import { SystemStatusSettingsPage } from '../pages/system-status-page';
import {
  type SettingsItemId,
  type SettingsPageTab,
  settingsSections,
  shownSettingsTab,
} from '../settings-tabs';
import NotificationSettingsCard from './NotificationSettingsCard';
import { OnboardingChecklistRow } from './OnboardingSettingsRow';
import { ReplayOnboardingRow } from './ReplayOnboardingRow';
import {
  AutoGenerateSessionNamesRow,
  AutoTrustWorktreesRow,
  PreserveSessionNameCapitalizationRow,
} from './SessionSettingsRows';
import TelemetrySettingsCard from './TelemetrySettingsCard';
import ThemeCard from './ThemeCard';

export { resolveSettingsTab, type SettingsPageTab } from '../settings-tabs';

function PreferencesSettingsPage() {
  return (
    <div className="space-y-8 pb-10">
      <PageHeader
        sticky
        title="Preferences"
        description="How Switch Console looks and behaves on this computer."
      />
      <ThemeCard />
      <AutoGenerateSessionNamesRow />
      <AutoTrustWorktreesRow />
      <PreserveSessionNameCapitalizationRow />
      <NotificationSettingsCard />
      <OnboardingChecklistRow />
      <ReplayOnboardingRow />
      <TelemetrySettingsCard />
    </div>
  );
}

const TAB_CONTENT: Record<SettingsPageTab, () => React.ReactNode> = {
  preferences: () => <PreferencesSettingsPage />,
  'messaging-apps': () => <MessagingAppsSettingsPage />,
  'clis-models': () => <AgentsSettingsPage />,
  'api-keys': () => <ApiKeysSettingsPage />,
  'remote-hosts': () => <RemoteHostsSettingsPage />,
  devices: () => <DevicesSettingsPage />,
  'managed-agents': () => <MigrationSettingsPage />,
  status: () => <SystemStatusSettingsPage />,
  account: () => <AccountSettingsPage />,
};

export const SettingsPage = observer(function SettingsPage({
  tab: activeTab,
  onTabChange,
}: {
  tab: SettingsPageTab;
  onTabChange: (tab: SettingsPageTab) => void;
}) {
  // Only offered while some server runs agent management: elsewhere there is
  // nothing to move to managed and nothing managed to look after.
  const agentManagement = useAnyServerFeatureFlag('agent_management');
  const { server, user } = settingsServer();
  // Workspace settings are the gateway's, open to every member there. A
  // Switch this Console runs without Docker serves no gateway.
  const workspaceSettings = server !== null && user !== null && servesWebGateway(server);
  const sections = settingsSections({
    hasServer: server !== null,
    agentManagement,
    workspaceSettings,
  });
  const shownTab = shownSettingsTab(activeTab, sections);

  const select = (id: SettingsItemId) => {
    if (id === 'docs') {
      void openExternalUrl(SWITCH_CONSOLE_DOCS_URL, 'Could not open the documentation');
    } else if (id === 'workspace-settings') {
      if (server) void openServerPage(server.id, `${dashboardOrigin(server)}/workspace`);
    } else {
      onTabChange(id);
    }
  };

  return (
    <PageLayout
      width={960}
      sidebar={
        <PageSidebarSections
          sections={sections}
          activeId={shownTab}
          onSelect={(item) => select(item.id)}
        />
      }
    >
      <PageContent>{TAB_CONTENT[shownTab]()}</PageContent>
    </PageLayout>
  );
});
