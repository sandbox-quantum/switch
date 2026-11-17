import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Info } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useState } from 'react';
import { ConnectorAppProfile } from '@renderer/features/admin/connector-app-profile';
import { useConnectorApps } from '@renderer/features/admin/connector-apps-queries';
import { ConnectorAppsTab } from '@renderer/features/admin/connector-apps-tab';
import { DecisionRoutingSection } from '@renderer/features/admin/decision-routing-section';
import { WorkspaceSwitchesTab } from '@renderer/features/admin/workspace-switches-tab';
import { connectorsPageAccess } from '@renderer/features/connectors/connectors-catalog';
import {
  useConnectorCatalog,
  useServerFeatureFlags,
} from '@renderer/features/connectors/connectors-queries';
import { FlagsUnreadable } from '@renderer/features/connectors/flags-unreadable';
import { GuardrailsSection } from '@renderer/features/switch-servers/GuardrailsSection';
import { openServerPage } from '@renderer/features/switch-servers/open-server-page';
import { operatesServer } from '@renderer/features/switch-servers/workspace-admin';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { PageHeader } from '@renderer/lib/components/page-header';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Alert, AlertTitle } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { Spinner } from '@renderer/lib/ui/spinner';
import { dashboardPageUrl, type SwitchServer } from '@shared/core/switch-servers/switch-servers';
import {
  administersOrganization,
  administersWorkspace,
  type Workspace,
} from '@shared/core/workspaces/workspaces';
import { SWITCH_TRUST_ABOUT_URL } from '@shared/urls';
import { OnSignedInServer } from './settings-server';

/** Under an admin page's title: what this person's role lets them do here. */
function AdminNotice({ children }: { children: ReactNode }) {
  return (
    <Alert variant="info" role="note">
      <Info />
      <AlertTitle>{children}</AlertTitle>
    </Alert>
  );
}

/**
 * How a notice names what lets this person act here: their role in the
 * workspace, or running the server, which lets them administer every
 * workspace on it without a role in any.
 */
function asRole(server: SwitchServer, workspace: Workspace): string {
  return administersWorkspace(workspace)
    ? 'As a workspace admin'
    : `As the person who runs ${server.name}`;
}

/** The workspace in scope on `serverId`, or a spinner while it is read. */
const InWorkspace = observer(function InWorkspace({
  serverId,
  children,
}: {
  serverId: string;
  children: (workspace: Workspace) => ReactNode;
}) {
  const workspace = workspacesStore.onServerInScope(serverId);
  if (workspace === null) return <Spinner />;
  return <>{children(workspace)}</>;
});

/**
 * The connector pages need the server's flags; when they could not be read
 * the page says so rather than reading them as off.
 */
function WithServiceConnections({ serverId, children }: { serverId: string; children: ReactNode }) {
  const flags = useServerFeatureFlags(serverId);
  const access = connectorsPageAccess(flags);
  if (access === 'unreadable') return <FlagsUnreadable flags={flags} />;
  if (access === 'loading') return <Spinner />;
  return <>{children}</>;
}

/** A workspace's switch for each service, for its admins. */
export function ConnectorsSettingsPage() {
  return (
    <OnSignedInServer>
      {({ server }) => (
        <InWorkspace serverId={server.id}>
          {(workspace) => (
            <WorkspaceConnectors key={workspace.id} server={server} workspace={workspace} />
          )}
        </InWorkspace>
      )}
    </OnSignedInServer>
  );
}

function WorkspaceConnectors({
  server,
  workspace,
}: {
  server: SwitchServer;
  workspace: Workspace;
}) {
  const [query, setQuery] = useState('');
  return (
    <div className="space-y-6 pb-10">
      <PageHeader
        sticky
        title="Connectors"
        description={`Choose which services people in ${workspace.name} can connect and give to their agents.`}
      >
        <AdminNotice>
          {asRole(server, workspace)}, you are able to turn each service on or off for everyone in{' '}
          {workspace.name}.
        </AdminNotice>
        <div className="space-y-2">
          <SearchInput
            containerClassName="w-full"
            aria-label="Search services"
            placeholder="Search by name or category"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <p className="text-xs text-foreground-muted">
            Turning a service off takes it from every agent within a minute. Turning it back on
            restores their access.
          </p>
        </div>
      </PageHeader>
      <WithServiceConnections serverId={server.id}>
        <WorkspaceSwitchesTab workspaceId={workspace.id} query={query} />
      </WithServiceConnections>
    </div>
  );
}

/** Which decision service a workspace's auto-route rooms ask, for its admins. */
export function DecisionRoutingSettingsPage() {
  return (
    <OnSignedInServer>
      {({ server }) => (
        <InWorkspace serverId={server.id}>
          {(workspace) => (
            <div className="space-y-6 pb-10">
              <PageHeader
                sticky
                title="Decision routing"
                description={`In an auto-route room, Switch asks a decision service which agent should answer a message that tags nobody. Choose the one ${workspace.name}’s rooms use.`}
              >
                <AdminNotice>
                  {asRole(server, workspace)}, you are able to choose the decision service for every
                  auto-route room in {workspace.name}.
                </AdminNotice>
              </PageHeader>
              {/* Keyed so a workspace switch reads that workspace's own setting. */}
              <DecisionRoutingSection key={workspace.id} workspaceId={workspace.id} />
            </div>
          )}
        </InWorkspace>
      )}
    </OnSignedInServer>
  );
}

/**
 * The guardrails that check a workspace's messages, for its admins to see.
 * Its organization's admins connect them, in the dashboard; everyone else
 * here reads them. A server from before each organization set its own keeps
 * its one form for the whole server, for whoever runs it.
 */
export function GuardrailsSettingsPage() {
  return (
    <OnSignedInServer>
      {({ server }) => (
        <InWorkspace serverId={server.id}>
          {(workspace) => (
            <div className="space-y-6 pb-10">
              <PageHeader
                sticky
                title="Guardrails"
                description={
                  <>
                    Checks that run on what is sent in {workspace.name} before it goes out. Powered
                    by{' '}
                    <button
                      type="button"
                      className="text-foreground underline underline-offset-3 hover:text-foreground-muted"
                      onClick={() =>
                        void openExternalUrl(SWITCH_TRUST_ABOUT_URL, 'Could not open Switch Trust')
                      }
                    >
                      Switch Trust
                    </button>
                    .
                  </>
                }
              >
                <AdminNotice>
                  {administersOrganization(workspace)
                    ? 'As an organization admin, you are able to change the guardrails for every workspace in your organization.'
                    : `${asRole(server, workspace)}, you are able to see which guardrails check ${workspace.name}. Only organization admins can change them.`}
                </AdminNotice>
              </PageHeader>
              <WorkspaceGuardrailsView key={workspace.id} server={server} workspace={workspace} />
            </div>
          )}
        </InWorkspace>
      )}
    </OnSignedInServer>
  );
}

function WorkspaceGuardrailsView({
  server,
  workspace,
}: {
  server: SwitchServer;
  workspace: Workspace;
}) {
  const guardrails = useQuery({
    queryKey: ['workspace-guardrails', workspace.id],
    queryFn: () => rpc.switchServers.getWorkspaceGuardrails(workspace.id),
    retry: false,
  });
  if (guardrails.isPending) return <Spinner />;
  if (guardrails.isError)
    return (
      <p className="text-sm text-destructive">
        {failureText(guardrails.error, 'Could not read which guardrails check this workspace.')}
      </p>
    );
  const result = guardrails.data;
  if (result.kind === 'unsupported')
    return operatesServer(server.id) ? (
      <GuardrailsSection serverId={server.id} initiallyOpen />
    ) : (
      <p className="text-sm text-foreground-muted">
        {server.name} sets one set of guardrails for the whole server. Whoever runs it can change
        them.
      </p>
    );
  if (result.kind === 'unauthenticated')
    return <p className="text-sm text-destructive">Your session has expired. Sign in again.</p>;
  if (result.kind === 'error')
    return (
      <p className="text-sm text-destructive">
        Could not read which guardrails check this workspace: {result.message}
      </p>
    );

  const { policyId, policyName, checking } = result.guardrails;
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm">
        {checking ? (
          <>
            Messages in {workspace.name} are checked by the Switch Trust policy{' '}
            <span className="font-medium">{policyName ?? policyId}</span>.
          </>
        ) : (
          `No guardrails check messages in ${workspace.name} yet.`
        )}
      </p>
      {administersOrganization(workspace) ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void openServerPage(
              server.id,
              dashboardPageUrl(server, 'settings/org/guardrails', workspace.tenantId)
            )
          }
        >
          Change in Organization settings
          <ExternalLink className="size-3.5" />
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void openServerPage(
              server.id,
              dashboardPageUrl(server, 'settings/guardrails', workspace.tenantId)
            )
          }
        >
          View in Workspace settings
          <ExternalLink className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

/**
 * The apps connectors sign people in through, for whoever runs a Switch that
 * serves no web gateway. A tile opens the app's profile in place; which one
 * is a Settings param, so the history arrows move between them.
 */
export function ConnectorAppsSettingsPage() {
  return (
    <OnSignedInServer>
      {({ server }) => (
        <InWorkspace serverId={server.id}>
          {(workspace) => (
            <ConnectorApps
              key={workspace.id}
              serverId={server.id}
              serverName={server.name}
              workspaceId={workspace.id}
            />
          )}
        </InWorkspace>
      )}
    </OnSignedInServer>
  );
}

function ConnectorApps({
  serverId,
  serverName,
  workspaceId,
}: {
  serverId: string;
  serverName: string;
  workspaceId: string;
}) {
  const { params } = useParams('settings');
  const { navigate } = useNavigate();
  const openApp = params.app ?? null;
  const [query, setQuery] = useState('');
  const apps = useConnectorApps(serverId, true);
  const catalog = useConnectorCatalog(workspaceId);
  // A failed check is remembered for the visit, so the tile says so after
  // the profile is left; a later check that passes clears it.
  const [checkFailures, setCheckFailures] = useState<Record<string, string>>({});
  const opened = openApp !== null ? apps.data?.apps.find((app) => app.slug === openApp) : undefined;

  if (opened)
    return (
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
          onBack={() => navigate('settings', { tab: 'connector-apps' })}
        />
      </div>
    );

  return (
    <div className="space-y-6 pb-10">
      <PageHeader
        sticky
        title="Connector apps"
        description={`Some connectors sign people in through an app you register with the vendor. Set each up once, and every workspace on ${serverName} uses it.`}
      >
        <AdminNotice>
          As the person who runs {serverName}, you are able to set up the apps its connectors sign
          in through.
        </AdminNotice>
        <SearchInput
          containerClassName="w-full"
          aria-label="Search apps"
          placeholder="Search by name or category"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </PageHeader>
      <WithServiceConnections serverId={serverId}>
        <ConnectorAppsTab
          serverId={serverId}
          apps={apps}
          catalog={catalog.data}
          query={query}
          checkFailures={checkFailures}
          onOpen={(slug) => navigate('settings', { tab: 'connector-apps', app: slug })}
        />
      </WithServiceConnections>
    </div>
  );
}
