import { ShieldCheck } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { connectorsPageAccess } from '@renderer/features/connectors/connectors-catalog';
import { useServerFeatureFlags } from '@renderer/features/connectors/connectors-queries';
import { ServerPage } from '@renderer/features/switch-servers/server-page';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { administersWorkspaceInScope } from '@renderer/features/switch-servers/workspace-admin';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { PageHeader } from '@renderer/lib/components/page-header';
import {
  PageContent,
  PageLayout,
  type PageSidebarGroup,
  PageSidebarGroups,
} from '@renderer/lib/components/page-layout';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { Spinner } from '@renderer/lib/ui/spinner';
import {
  ADMIN_SECTION_LABELS,
  type AdminGroup,
  type AdminSection,
  adminGroups,
  shownAdminSection,
} from './admin-sections';
import { WorkspaceSwitchesTab } from './workspace-switches-tab';

type AdminParams = {
  serverId: string;
  /** The section asked for; the first the person may use when absent or not theirs. */
  section?: AdminSection;
};

/** Wider than a list page, so the tiles keep two columns beside the side menu. */
const WIDTH = 1120;

const AdminTitlebar = observer(function AdminTitlebar() {
  const { serverId } = useParams('admin').params;
  return <ServerSectionTitlebar serverId={serverId} icon={ShieldCheck} label="Admin" />;
});

/**
 * What the workspace's admins, and the server's operator, manage for other
 * people. Laid out like Settings: its sections down the side, grouped by
 * what they reach, each shown only to the role that may use it. Like the
 * Connectors page it is behind the server's `service_connections` flag,
 * since everything on it is about connectors: with it off there is no page,
 * and reaching it anyway goes to Your Agents.
 */
const AdminPanel = observer(function AdminPanel() {
  const { params } = useParams('admin');
  const { serverId } = params;
  const { navigate } = useNavigate();
  const access = connectorsPageAccess(useServerFeatureFlags(serverId));
  const workspace = workspacesStore.onServerInScope(serverId);
  useEffect(() => {
    if (access === 'absent') navigate('serverAgents', { serverId });
  }, [access, navigate, serverId]);

  if (access !== 'shown' || workspace === null)
    return (
      <ServerPage width={880} title="Admin" description="">
        <Spinner />
      </ServerPage>
    );
  const groups = adminGroups({ administers: administersWorkspaceInScope(serverId) });
  const section = shownAdminSection(groups, params.section);
  if (section === null)
    return (
      <ServerPage width={880} title="Admin" description="Ask a workspace admin to change these.">
        {null}
      </ServerPage>
    );
  // Keyed so a workspace switch starts the search afresh.
  return (
    <Admin
      key={workspace.id}
      groups={groups}
      section={section}
      workspace={workspace}
      serverName={switchServersStore.servers.find((s) => s.id === serverId)?.name ?? 'This server'}
      onSection={(next) => navigate('admin', { serverId, section: next })}
    />
  );
});

function Admin({
  groups,
  section,
  workspace,
  serverName,
  onSection,
}: {
  groups: AdminGroup[];
  section: AdminSection;
  workspace: { id: string; name: string };
  serverName: string;
  onSection: (section: AdminSection) => void;
}) {
  const [query, setQuery] = useState('');
  const detail = { workspace: workspace.name, server: serverName };
  const menu: PageSidebarGroup<AdminSection>[] = groups.map((group) => ({
    label: group.scope === 'workspace' ? 'Workspace' : 'Server',
    detail: detail[group.scope],
    items: group.sections.map((id) => ({ id, label: ADMIN_SECTION_LABELS[id] })),
  }));
  return (
    <div className="relative z-10 flex min-h-0 flex-1 overflow-hidden bg-background">
      <PageLayout
        width={WIDTH}
        sidebar={
          <PageSidebarGroups
            groups={menu}
            activeId={section}
            onSelect={(item) => {
              setQuery('');
              onSection(item.id);
            }}
          />
        }
      >
        <PageContent className="px-0">
          <div className="space-y-6 pb-10">
            <PageHeader
              sticky
              title={ADMIN_SECTION_LABELS[section]}
              description={`Choose which services people in ${workspace.name} can connect and give to their agents.`}
            >
              <div className="space-y-2">
                <SearchInput
                  containerClassName="w-full"
                  aria-label="Search services"
                  placeholder="Search by name or category"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <p className="text-xs text-foreground-muted">
                  Turning a service off takes it from every agent within a minute. Turning it back
                  on restores their access.
                </p>
              </div>
            </PageHeader>
            <WorkspaceSwitchesTab workspaceId={workspace.id} query={query} />
          </div>
        </PageContent>
      </PageLayout>
    </div>
  );
}

export const adminView = {
  WrapView: ({ children }: { children: React.ReactNode } & AdminParams) => <>{children}</>,
  TitlebarSlot: AdminTitlebar,
  MainPanel: AdminPanel,
  canActivate: (params: unknown): GuardResult => {
    const serverId =
      typeof params === 'object' && params !== null
        ? (params as { serverId?: unknown }).serverId
        : undefined;
    if (typeof serverId !== 'string') return { ok: false, redirect: 'home' };
    return { ok: true };
  },
} satisfies ViewDefinition<AdminParams>;
