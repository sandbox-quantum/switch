import React, { useCallback } from 'react';
import { MigrationSettingsPage } from '@renderer/features/agent-migration/migration-settings-page';
import { RemoteHostsSettingsPage } from '@renderer/features/remote-hosts/views/remote-hosts-view';
import { PageHeader } from '@renderer/lib/components/page-header';
import { PageContent, PageLayout, PageSidebarMenu } from '@renderer/lib/components/page-layout';
import { useAnyServerFeatureFlag } from '@renderer/lib/hooks/useFeatureFlags';
import { openExternalUrl } from '@renderer/lib/open-external';
import { SWITCH_CONSOLE_DOCS_URL } from '@shared/urls';
import { AgentsSettingsPage } from '../agents-page/AgentsSettingsPage';
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
import { UpdateCard } from './UpdateCard';

export type SettingsPageTab =
  | 'general'
  | 'clis-models'
  | 'integrations'
  | 'connections'
  | 'browser'
  | 'interface'
  | 'remote-hosts'
  | 'managed-agents'
  | 'docs';

// ---------------------------------------------------------------------------
// Tab page components
// ---------------------------------------------------------------------------

function GeneralSettingsPage() {
  return (
    <div className="space-y-8 pb-10">
      <PageHeader
        sticky
        title="General"
        description="Manage your account, privacy settings, notifications, and app updates."
      />
      <UpdateCard />
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

function InterfaceSettingsPage() {
  return (
    <div className="space-y-8 pb-4">
      <PageHeader
        sticky
        title="Interface"
        description="Customize the appearance and behavior of the app."
      />
      <ThemeCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingsPage
// ---------------------------------------------------------------------------

/**
 * The tabs that have a pane to show. `docs` is an external link, and several
 * `SettingsPageTab` values are hidden in v0, so this is a subset.
 */
const TAB_CONTENT: Partial<Record<SettingsPageTab, () => React.ReactNode>> = {
  general: () => <GeneralSettingsPage />,
  'clis-models': () => <AgentsSettingsPage />,
  interface: () => <InterfaceSettingsPage />,
  'remote-hosts': () => <RemoteHostsSettingsPage />,
  'managed-agents': () => <MigrationSettingsPage />,
};

/**
 * A persisted snapshot can name a tab this build no longer renders — one hidden
 * in v0, or retired outright. Showing Settings with an empty pane and no tab
 * selected reads as broken, so fall back to General.
 */
export function resolveSettingsTab(tab: unknown): SettingsPageTab {
  return typeof tab === 'string' && Object.hasOwn(TAB_CONTENT, tab)
    ? (tab as SettingsPageTab)
    : 'general';
}

export function SettingsPage({
  tab: activeTab,
  onTabChange,
}: {
  tab: SettingsPageTab;
  onTabChange: (tab: SettingsPageTab) => void;
}) {
  // Only offered while some server runs agent management: elsewhere there is
  // nothing to move to managed and nothing managed to look after.
  const agentManagement = useAnyServerFeatureFlag('agent_management');
  const handleDocsClick = useCallback(() => {
    void openExternalUrl(SWITCH_CONSOLE_DOCS_URL, 'Could not open the documentation');
  }, []);

  type Tab = {
    id: SettingsPageTab;
    label: string;
    isExternal?: boolean;
  };
  const allTabs: Tab[] = [
    // Switch Console v0 hides Account, Integrations, Connections (SSH), and Browser tabs.
    { id: 'general', label: 'General' },
    { id: 'clis-models', label: 'Agent providers' },
    { id: 'remote-hosts', label: 'Remote hosts' },
    { id: 'managed-agents', label: 'Managed agents' },
    { id: 'interface', label: 'Interface' },
    { id: 'docs', label: 'Docs', isExternal: true },
  ];
  const tabs = allTabs.filter((tab) => agentManagement || tab.id !== 'managed-agents');

  const shownTab = !agentManagement && activeTab === 'managed-agents' ? 'general' : activeTab;
  const currentContent = TAB_CONTENT[shownTab]?.();

  return (
    <PageLayout
      width={880}
      sidebar={
        <PageSidebarMenu
          items={tabs}
          activeId={shownTab}
          onSelect={(item) => {
            if (item.isExternal) {
              handleDocsClick();
            } else {
              onTabChange(item.id);
            }
          }}
        />
      }
    >
      {currentContent && <PageContent>{currentContent}</PageContent>}
    </PageLayout>
  );
}
