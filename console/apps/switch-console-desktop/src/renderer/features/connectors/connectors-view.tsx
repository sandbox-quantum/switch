import { ArrowRight, Check, Plug, Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { ServerPage } from '@renderer/features/switch-servers/server-page';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { administersWorkspaceInScope } from '@renderer/features/switch-servers/workspace-admin';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { Alert, AlertAction, AlertDescription } from '@renderer/lib/ui/alert';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { TONE_BADGE, connectorCardState } from './connector-card-state';
import { ConnectorProfile } from './connector-profile';
import { ConnectorTile } from './connector-tile';
import {
  type ConnectorsTab,
  cardQuickAction,
  connectorsInTab,
  connectorsPageAccess,
} from './connectors-catalog';
import { useConnectorCatalog, useServerFeatureFlags } from './connectors-queries';
import { offersAddAgent } from './grant-agents';
import { useConnectService } from './use-connect-service';

function useServerId(): string {
  return useParams('connectors').params.serverId;
}

const ConnectorsTitlebar = observer(function ConnectorsTitlebar() {
  return <ServerSectionTitlebar serverId={useServerId()} icon={Plug} label="Connectors" />;
});

const DESCRIPTION =
  'Connect the services your agents work with. An agent uses one only once you turn it on for that agent.';

/**
 * The connector catalog of the workspace in scope on the server. Behind the
 * server's `service_connections` flag: with it off there is no page, and
 * reaching it anyway goes to Your Agents rather than drawing an empty one.
 */
const ConnectorsPanel = observer(function ConnectorsPanel() {
  const serverId = useServerId();
  const { navigate } = useNavigate();
  const access = connectorsPageAccess(useServerFeatureFlags(serverId));
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  useEffect(() => {
    if (access === 'absent') navigate('serverAgents', { serverId });
  }, [access, navigate, serverId]);

  if (access !== 'shown' || workspaceId === null)
    return (
      <ServerPage width={880} title="Connectors" description={DESCRIPTION}>
        <Spinner />
      </ServerPage>
    );
  // Keyed so a workspace switch starts from the catalog, not another workspace's profile.
  return (
    <Connectors
      key={workspaceId}
      serverId={serverId}
      workspaceId={workspaceId}
      administers={administersWorkspaceInScope(serverId)}
    />
  );
});

/**
 * The catalog, or one connector's profile in front of it. Which is open is a
 * view param, so the sidebar's Connectors entry and the history arrows move
 * between the two as they do between a room and Your Rooms. Whether the
 * profile opened because the service was just connected is this page's own
 * business, kept here and dropped as soon as the person moves on.
 */
function Connectors({
  serverId,
  workspaceId,
  administers,
}: {
  serverId: string;
  workspaceId: string;
  administers: boolean;
}) {
  const catalog = useConnectorCatalog(workspaceId);
  const [tab, setTab] = useState<ConnectorsTab>('yours');
  const [query, setQuery] = useState('');
  const { navigate } = useNavigate();
  const open = useParams('connectors').params.connector ?? null;
  const [justConnected, setJustConnected] = useState<{
    slug: string;
    warning: string | null;
  } | null>(null);
  useEffect(() => {
    if (justConnected && justConnected.slug !== open) setJustConnected(null);
  }, [open, justConnected]);
  const openProfile = (slug: string) => navigate('connectors', { serverId, connector: slug });
  const connect = useConnectService(serverId, workspaceId);

  const tabs = [
    { value: 'yours', label: 'Yours' },
    { value: 'discover', label: 'Discover' },
  ] as const satisfies readonly { value: ConnectorsTab; label: string }[];

  const opened = open === null ? null : catalog.data?.find((entry) => entry.slug === open);
  // The profile replaces the whole page, title included: it is a place of its
  // own, reached from the catalog, with the way back at its top. Same column
  // as `ServerPage`, so moving between the two does not shift the content.
  // A failed re-read keeps the last data, so the profile says so rather than
  // showing what may no longer be true as if it were.
  if (opened)
    return (
      <div className="relative z-10 flex min-h-0 flex-1 flex-col bg-background">
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <div className="mx-auto w-full space-y-4 px-10 py-8" style={{ maxWidth: 880 }}>
            {catalog.isError && (
              <CatalogError error={catalog.error} onRetry={() => void catalog.refetch()} />
            )}
            <ConnectorProfile
              key={opened.slug}
              serverId={serverId}
              workspaceId={workspaceId}
              connection={opened}
              administers={administers}
              justConnected={
                justConnected?.slug === opened.slug ? { warning: justConnected.warning } : null
              }
              onBack={() => navigate('connectors', { serverId })}
            />
          </div>
        </div>
      </div>
    );

  return (
    <ServerPage
      width={880}
      title="Connectors"
      description={DESCRIPTION}
      action={
        // Turning a service on or off for everyone is the Admin page's; only
        // the way there is here, for whoever may.
        administers && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('admin', { serverId, section: 'connectors' })}
          >
            Manage in Admin
            <ArrowRight className="size-3.5" />
          </Button>
        )
      }
    >
      <div className="flex items-center gap-3">
        <SegmentedControl ariaLabel="Connectors" value={tab} onChange={setTab} options={tabs} />
        <SearchInput
          containerClassName="flex-1"
          aria-label="Search connectors"
          placeholder="Search by name, category or description"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {catalog.isError ? (
        <CatalogError error={catalog.error} onRetry={() => void catalog.refetch()} />
      ) : !catalog.data ? (
        <p className="flex items-center gap-2 text-sm">
          <Spinner /> Loading connectors…
        </p>
      ) : (
        <ConnectorGrid
          entries={connectorsInTab(catalog.data, tab, query)}
          tab={tab}
          query={query}
          onOpen={openProfile}
          onConnect={(entry) =>
            connect(entry, 'connect', (warning) => {
              if (!offersAddAgent(entry)) return;
              openProfile(entry.slug);
              setJustConnected({ slug: entry.slug, warning });
            })
          }
        />
      )}
    </ServerPage>
  );
}

function CatalogError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{failureText(error, 'Could not load the connectors.')}</AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </AlertAction>
    </Alert>
  );
}

function ConnectorGrid({
  entries,
  tab,
  query,
  onOpen,
  onConnect,
}: {
  entries: ConnectionCatalogEntry[];
  tab: ConnectorsTab;
  query: string;
  onOpen: (slug: string) => void;
  onConnect: (entry: ConnectionCatalogEntry) => void;
}) {
  if (entries.length === 0)
    return (
      <p className="text-sm text-foreground-muted">
        {query.trim()
          ? `No connector matches “${query.trim()}”.`
          : tab === 'yours'
            ? 'You have not connected anything yet. Find a service under Discover.'
            : 'This server offers no connectors.'}
      </p>
    );
  return (
    <div
      role="group"
      aria-label="Connectors"
      className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3"
    >
      {entries.map((entry) => (
        <ConnectorCard
          key={entry.slug}
          entry={entry}
          onOpen={() => onOpen(entry.slug)}
          onConnect={() => onConnect(entry)}
        />
      ))}
    </div>
  );
}

/**
 * One catalog card, showing one state with its reason. The whole card opens
 * the profile; the control at its top right connects in one click, or marks
 * a connection that is there and usable. Disconnecting is only on the profile.
 */
function ConnectorCard({
  entry,
  onOpen,
  onConnect,
}: {
  entry: ConnectionCatalogEntry;
  onOpen: () => void;
  onConnect: () => void;
}) {
  const state = connectorCardState(entry);
  const quick = cardQuickAction(entry, state);
  return (
    <ConnectorTile
      slug={entry.slug}
      name={entry.name}
      inert={state.kind === 'coming_soon'}
      onOpen={onOpen}
      control={
        quick === 'connect' ? (
          <Button
            variant="outline"
            size="icon"
            aria-label={`Connect ${entry.name}`}
            title={`Connect ${entry.name}`}
            onClick={onConnect}
          >
            <Plus className="size-4" />
          </Button>
        ) : quick === 'connected' ? (
          <span
            role="img"
            aria-label={`${entry.name} connected`}
            title="Connected"
            className="flex size-8 items-center justify-center rounded-md border border-border-success bg-background-success text-foreground-success"
          >
            <Check className="size-4" />
          </span>
        ) : null
      }
    >
      <span className="mt-1 line-clamp-2 block text-sm text-foreground-muted">
        {entry.description}
      </span>
      <span className="mt-2 flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
        {entry.category}
        {state.kind !== 'connect' && state.kind !== 'connected' && (
          <Badge variant={TONE_BADGE[state.tone]}>{state.label}</Badge>
        )}
      </span>
      {state.detail && (
        <span className="mt-1 block text-xs text-foreground-muted">{state.detail}</span>
      )}
    </ConnectorTile>
  );
}

export const connectorsView = {
  WrapView: ({
    children,
  }: {
    children: React.ReactNode;
    serverId: string;
    /** The connector whose profile is open in front of the catalog. */
    connector?: string;
  }) => <>{children}</>,
  TitlebarSlot: ConnectorsTitlebar,
  MainPanel: ConnectorsPanel,
  canActivate: (params: unknown): GuardResult => {
    const serverId =
      typeof params === 'object' && params !== null
        ? (params as { serverId?: unknown }).serverId
        : undefined;
    if (typeof serverId !== 'string') return { ok: false, redirect: 'home' };
    return { ok: true };
  },
} satisfies ViewDefinition<{ serverId: string; connector?: string }>;
