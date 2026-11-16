import { observer } from 'mobx-react-lite';
import React from 'react';
import { MigrationSettingsPage } from '@renderer/features/agent-migration/migration-settings-page';
import { DevicesSettingsPage } from '@renderer/features/machines/devices-settings-page';
import { RemoteHostsSettingsPage } from '@renderer/features/remote-hosts/views/remote-hosts-view';
import { startManagedServer } from '@renderer/features/switch-servers/managed-server-actions';
import { openServerPage } from '@renderer/features/switch-servers/open-server-page';
import {
  servesWebGateway,
  webGatewayNeedsRestart,
} from '@renderer/features/switch-servers/server-gateway';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { PageHeader } from '@renderer/lib/components/page-header';
import { PageContent, PageLayout, PageSidebarSections } from '@renderer/lib/components/page-layout';
import { useAnyServerFeatureFlag } from '@renderer/lib/hooks/useFeatureFlags';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { openExternalUrl } from '@renderer/lib/open-external';
import { log } from '@renderer/utils/logger';
import { settingsPagePath } from '@shared/core/switch-servers/dashboard-pages';
import { dashboardPageUrl, type SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { administersOrganization } from '@shared/core/workspaces/workspaces';
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
        description="Customize how Switch Console looks and behaves on this computer."
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

/**
 * Whether the server's gateway has its new layout on. Its flags are read first
 * when they never have been, so a click made before they arrive still lands on
 * the settings home. Flags belong to the deployment, not to a workspace, so
 * the answer holds for every workspace on the server.
 *
 * Flags that cannot be read count as off, which opens today's addresses: every
 * server serves them and the new layout redirects them, but there Workspace
 * settings then lands on its Users page, so the fallback is logged.
 */
async function newGatewayLayout(server: SwitchServer): Promise<boolean> {
  let cause: unknown;
  try {
    const res = await rpc.featureFlags.current(server.id);
    if (res.success && res.data.fetchedAt !== null) return res.data.flags.gateway_v2;
    cause = res.success ? (res.data.error ?? 'not read yet') : res.error;
  } catch (thrown) {
    cause = thrown;
  }
  log.warn(
    "Settings: could not read the server's feature flags, so its gateway settings open at their older addresses",
    { serverId: server.id, cause }
  );
  return false;
}

/**
 * Open a workspace's or an organization's settings in the gateway, for the
 * workspace `tenantId` names and in the layout the server has on.
 */
async function openGatewaySettings(
  server: SwitchServer,
  link: 'workspace-settings' | 'organization-settings',
  tenantId: string | null
): Promise<void> {
  const newLayout = await newGatewayLayout(server);
  await openServerPage(
    server.id,
    dashboardPageUrl(server, settingsPagePath(link, newLayout), tenantId)
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
  const showConfirm = useShowModal('confirmActionModal');
  // Workspace settings are the gateway's, open to every member there. A
  // Switch this Console runs without Docker serves it once started with its
  // pages; one an older Console started is offered the restart that does.
  const restartForGateway = server !== null && webGatewayNeedsRestart(server);
  const workspaceSettings =
    server !== null && user !== null && (servesWebGateway(server) || restartForGateway);
  // The organization's settings are the gateway's too, offered to its admins.
  const workspace = server !== null ? workspacesStore.onServerInScope(server.id) : null;
  const organizationSettings =
    workspaceSettings && workspace !== null && administersOrganization(workspace);
  const sections = settingsSections({
    hasServer: server !== null,
    agentManagement,
    workspaceSettings,
    organizationSettings,
  });
  const shownTab = shownSettingsTab(activeTab, sections);

  const select = (id: SettingsItemId) => {
    if (id === 'docs') {
      void openExternalUrl(SWITCH_CONSOLE_DOCS_URL, 'Could not open the documentation');
    } else if (id === 'workspace-settings' || id === 'organization-settings') {
      if (!server) return;
      const workspacePage = id === 'workspace-settings';
      if (restartForGateway) {
        showConfirm({
          title: 'Restart the local server?',
          description: `${workspacePage ? 'Workspace' : 'Organization'} settings are in the web gateway, which this server turns on when it restarts. Running agents reconnect once it is back.`,
          confirmLabel: 'Restart',
          onSuccess: () => startManagedServer(server),
        });
      } else {
        void openGatewaySettings(server, id, workspace?.tenantId ?? null);
      }
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
