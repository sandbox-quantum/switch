import React, { useCallback } from 'react';
import { PageHeader } from '@renderer/lib/components/page-header';
import { PageContent, PageLayout, PageSidebarMenu } from '@renderer/lib/components/page-layout';
import { openExternalUrl } from '@renderer/lib/open-external';
import { AgentsSettingsPage } from '../agents-page/AgentsSettingsPage';
import HiddenToolsSettingsCard from './HiddenToolsSettingsCard';
import InterfaceSettingsCard from './InterfaceSettingsCard';
import KeyboardSettingsCard from './KeyboardSettingsCard';
import NotificationSettingsCard from './NotificationSettingsCard';
import RemoteAttachmentSettingsCard from './RemoteAttachmentSettingsCard';
import ResourceMonitorSettingsCard from './ResourceMonitorSettingsCard';
import {
  AutoGenerateSessionNamesRow,
  AutoTrustWorktreesRow,
  CreateBranchAndWorktreeRow,
  EnableTmuxRow,
  IncludeIssueContextByDefaultRow,
  PreserveSessionNameCapitalizationRow,
} from './SessionSettingsRows';
import SidebarMetadataSettingsCard from './SidebarMetadataSettingsCard';
import TerminalSettingsCard from './TerminalSettingsCard';
import ThemeCard from './ThemeCard';
import { UpdateCard } from './UpdateCard';

export type SettingsPageTab =
  | 'general'
  | 'clis-models'
  | 'integrations'
  | 'connections'
  | 'browser'
  | 'interface'
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
      <CreateBranchAndWorktreeRow />
      <PreserveSessionNameCapitalizationRow />
      <IncludeIssueContextByDefaultRow />
      <EnableTmuxRow />
      <NotificationSettingsCard />
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
      <TerminalSettingsCard />
      <SidebarMetadataSettingsCard />
      <ResourceMonitorSettingsCard />
      <RemoteAttachmentSettingsCard />
      <InterfaceSettingsCard />
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-normal text-foreground">Keyboard shortcuts</h3>
        <KeyboardSettingsCard />
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-normal text-foreground">Tools</h3>
        <HiddenToolsSettingsCard />
      </div>
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
  const handleDocsClick = useCallback(() => {
    void openExternalUrl(
      'https://github.com/sandbox-quantum/switch',
      'Could not open the documentation'
    );
  }, []);

  const tabs: Array<{
    id: SettingsPageTab;
    label: string;
    isExternal?: boolean;
  }> = [
    // Switch Console v0 hides Account, Integrations, Connections (SSH), and Browser tabs.
    { id: 'general', label: 'General' },
    { id: 'clis-models', label: 'Agents' },
    { id: 'interface', label: 'Interface' },
    { id: 'docs', label: 'Docs', isExternal: true },
  ];

  const currentContent = TAB_CONTENT[activeTab]?.();

  return (
    <PageLayout
      sidebar={
        <PageSidebarMenu
          items={tabs}
          activeId={activeTab}
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
