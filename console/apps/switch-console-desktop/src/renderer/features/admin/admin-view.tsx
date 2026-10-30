import { ShieldCheck } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { connectorsPageAccess } from '@renderer/features/connectors/connectors-catalog';
import {
  useConnectorCatalog,
  useServerFeatureFlags,
} from '@renderer/features/connectors/connectors-queries';
import { ServerPage } from '@renderer/features/switch-servers/server-page';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { operatesServer } from '@renderer/features/switch-servers/workspace-admin';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { PageHeader } from '@renderer/lib/components/page-header';
import { PageContent } from '@renderer/lib/components/page-layout';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { Spinner } from '@renderer/lib/ui/spinner';
import { AdminFrame, adminGroupsInScope } from './admin-frame';
import {
  ADMIN_MENU_LABELS,
  type AdminGroup,
  type AdminSection,
  shownAdminSection,
} from './admin-sections';
import { ConnectorAppProfile } from './connector-app-profile';
import { useConnectorApps } from './connector-apps-queries';
import { ConnectorAppsTab } from './connector-apps-tab';
import { DecisionRoutingSection } from './decision-routing-section';
import { WorkspaceSwitchesTab } from './workspace-switches-tab';

type AdminParams = {
  serverId: string;
  /** The section asked for; the first the person may use when absent or not theirs. */
  section?: AdminSection;
  /** The connector app whose profile is open in the Connector apps section. */
  app?: string;
};

const AdminTitlebar = observer(function AdminTitlebar() {
  const { serverId } = useParams('admin').params;
  return <ServerSectionTitlebar serverId={serverId} icon={ShieldCheck} label="Admin" />;
});

/**
 * What the workspace's admins, and the server's operator, manage for other
 * people. Laid out like Settings: its sections down the side, grouped by
 * what they reach, each shown only to the role that may use it. The sections
 * about connectors are, like the Connectors page, behind the server's
 * `service_connections` flag; the workspace's decision routing is not. A
 * server this Console runs also has its status in the menu, drawn by the
 * `managedServer` view: whoever has no section of their own here is sent
 * there, and, where there is no status either, to Your Agents.
 */
const AdminPanel = observer(function AdminPanel() {
  const { params } = useParams('admin');
  const { serverId } = params;
  const { navigate } = useNavigate();
  const access = connectorsPageAccess(useServerFeatureFlags(serverId));
  const workspace = workspacesStore.onServerInScope(serverId);
  const groups = adminGroupsInScope(serverId, access === 'shown');
  const section = shownAdminSection(groups, params.section);
  const hasStatus = groups.some((group) => group.items.includes('status'));
  const redirect =
    access === 'loading' || section !== null
      ? null
      : hasStatus
        ? 'managedServer'
        : access === 'absent'
          ? 'serverAgents'
          : null;
  useEffect(() => {
    if (redirect !== null) navigate(redirect, { serverId });
  }, [redirect, navigate, serverId]);

  if (access === 'loading' || workspace === null || redirect !== null)
    return (
      <ServerPage width={880} title="Admin" description="">
        <Spinner />
      </ServerPage>
    );
  const operator = operatesServer(serverId);
  if (section === null)
    return (
      <ServerPage width={880} title="Admin" description="Ask a workspace admin to change these.">
        {null}
      </ServerPage>
    );
  if (section === 'decision')
    return (
      <AdminFrame serverId={serverId} groups={groups} active="decision">
        <PageContent className="px-0">
          <div className="space-y-6 pb-10">
            <PageHeader
              sticky
              title={ADMIN_MENU_LABELS.decision}
              description={`In an auto-route room, Switch asks a decision service which agent should answer a message that tags nobody. Choose the one ${workspace.name}’s rooms use.`}
            />
            {/* Keyed so a workspace switch reads that workspace's own setting. */}
            <DecisionRoutingSection key={workspace.id} workspaceId={workspace.id} />
          </div>
        </PageContent>
      </AdminFrame>
    );
  // Keyed so a workspace switch starts the search afresh.
  return (
    <Admin
      key={workspace.id}
      serverId={serverId}
      operator={operator}
      groups={groups}
      section={section}
      openApp={params.app ?? null}
      workspace={workspace}
      serverName={switchServersStore.servers.find((s) => s.id === serverId)?.name ?? 'This server'}
    />
  );
});

/**
 * The side menu and one section beside it, or a connector app's profile in
 * that column. Which is open is a view param, so the history arrows move
 * between them as they do on the Connectors page.
 */
function Admin({
  serverId,
  operator,
  groups,
  section,
  openApp,
  workspace,
  serverName,
}: {
  serverId: string;
  operator: boolean;
  groups: AdminGroup[];
  section: Exclude<AdminSection, 'decision'>;
  openApp: string | null;
  workspace: { id: string; name: string };
  serverName: string;
}) {
  const { navigate } = useNavigate();
  const [query, setQuery] = useState('');
  // Another section starts its search afresh.
  const [searchedSection, setSearchedSection] = useState(section);
  if (searchedSection !== section) {
    setSearchedSection(section);
    setQuery('');
  }
  const apps = useConnectorApps(serverId, operator);
  const catalog = useConnectorCatalog(workspace.id);
  // A failed check is remembered for the visit, so the tile says so after
  // the profile is left; a later check that passes clears it.
  const [checkFailures, setCheckFailures] = useState<Record<string, string>>({});

  const opened =
    section === 'apps' && openApp !== null
      ? apps.data?.apps.find((app) => app.slug === openApp)
      : undefined;

  return (
    <AdminFrame serverId={serverId} groups={groups} active={section}>
      <PageContent className="px-0">
        {opened ? (
          <div className="pt-10 pb-10">
            <ConnectorAppProfile
              key={opened.slug}
              serverId={serverId}
              app={opened}
              publicUrl={apps.data?.public_url ?? null}
              checkFailure={checkFailures[opened.slug] ?? null}
              onCheckFailure={(message) =>
                setCheckFailures((current) => {
                  const next = { ...current };
                  if (message === null) delete next[opened.slug];
                  else next[opened.slug] = message;
                  return next;
                })
              }
              onBack={() => navigate('admin', { serverId, section: 'apps' })}
            />
          </div>
        ) : (
          <div className="space-y-6 pb-10">
            <PageHeader
              sticky
              title={ADMIN_MENU_LABELS[section]}
              description={
                section === 'apps'
                  ? `Some connectors sign people in through an app you register with the vendor. Set each up once, and every workspace on ${serverName} uses it.`
                  : `Choose which services people in ${workspace.name} can connect and give to their agents.`
              }
            >
              <div className="space-y-2">
                <SearchInput
                  containerClassName="w-full"
                  aria-label={section === 'apps' ? 'Search apps' : 'Search services'}
                  placeholder="Search by name or category"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {section === 'connectors' && (
                  <p className="text-xs text-foreground-muted">
                    Turning a service off takes it from every agent within a minute. Turning it back
                    on restores their access.
                  </p>
                )}
              </div>
            </PageHeader>
            {section === 'apps' ? (
              <ConnectorAppsTab
                serverId={serverId}
                apps={apps}
                catalog={catalog.data}
                query={query}
                checkFailures={checkFailures}
                onOpen={(slug) => navigate('admin', { serverId, section: 'apps', app: slug })}
              />
            ) : (
              <WorkspaceSwitchesTab workspaceId={workspace.id} query={query} />
            )}
          </div>
        )}
      </PageContent>
    </AdminFrame>
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
