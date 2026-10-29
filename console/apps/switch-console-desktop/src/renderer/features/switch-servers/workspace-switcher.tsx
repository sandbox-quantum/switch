import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronsUpDown, Plus, Search, Server, UserPlus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Fragment, useEffect, useState } from 'react';
import { ChatsOfflineNote } from '@renderer/features/chats/components/chats-offline-note';
import type { CreateTarget } from '@renderer/features/workspaces/create-workspace-modal';
import {
  addWorkspaceThrough,
  type CreationAnswer,
  groupByOrganization,
} from '@renderer/features/workspaces/organization-groups';
import {
  InvitedBadge,
  invitationSummary,
  joinableSummary,
  joinableWorkspacesKey,
  listedInvitations,
  listedJoinable,
  pendingInvitationsKey,
  useJoinableWorkspaces,
  usePendingInvitations,
} from '@renderer/features/workspaces/pending-invitations';
import { WorkspaceAvatar } from '@renderer/features/workspaces/workspace-avatar';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { SwitchConsoleMark } from '@renderer/lib/switch-console-mark';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';
import { runsOnThisComputer, type SwitchServer } from '@shared/core/switch-servers/switch-servers';
import type { JoinableWorkspace, PendingInvitation } from '@shared/core/workspaces/invitations';
import {
  administersWorkspace,
  type Workspace,
  type WorkspaceUnavailability,
  workspaceUnavailability,
} from '@shared/core/workspaces/workspaces';
import { localServerStore } from './local-server-store';
import { ManagedServerDot } from './managed-server-dot';
import { remoteServerStore } from './remote-server-store';
import { serverAvailability } from './server-availability';
import { serverIcon } from './server-icon';
import {
  ServerAvatar,
  ServerDriftIndicator,
  ServerStatusDot,
  serverDrift,
  serverPlacementLabel,
  serverState,
  serverStatusLabel,
} from './server-presentation';
import { switchServersStore } from './switch-servers-store';
import { type SwitchCloudAvailability, useSwitchCloud } from './use-switch-cloud';

/**
 * A server this Console does not run, said only when something is wrong with
 * it: the switcher carries no status words, and a reachable server needs no
 * mark at all. Signed out or unreachable still shows, as a dot whose label
 * says which, since the menu is otherwise the only place it would be found.
 */
const ServerProblemDot = observer(function ServerProblemDot({ server }: { server: SwitchServer }) {
  const state = serverState(server);
  if (state === 'connected' || state === 'running-local') return null;
  const label = serverStatusLabel(server);
  return (
    <span role="img" aria-label={label} title={label} className="flex shrink-0">
      <ServerStatusDot server={server} />
    </span>
  );
});

/**
 * Whether the sidebar shows servers rather than workspaces.
 *
 * Workspaces are a Switch Cloud idea, so a build that cannot reach the Cloud
 * keeps the server list it had before them. A server row opens one workspace
 * on that server; any others the account has there are not offered from the
 * sidebar on such a build. A build whose Cloud configuration could not be read
 * keeps the workspace menu, so the broken configuration stays visible.
 */
export function showsServers(cloud: SwitchCloudAvailability['kind']): boolean {
  return cloud === 'reading' || cloud === 'closed';
}

/**
 * The workspace a server row opens: the one the window is already in when it
 * is on that server, otherwise the first that can be opened. Null when there is
 * none to open, with the first workspace's reason when there is one to give.
 */
export function serverRowWorkspace(
  workspaces: Workspace[],
  activeId: string | null
): { workspace: Workspace | null; unavailable: WorkspaceUnavailability | null } {
  const active = workspaces.find((w) => w.id === activeId);
  if (active) return { workspace: active, unavailable: null };
  const open = workspaces.find((w) => workspaceUnavailability(w, workspaces.length) === null);
  if (open) return { workspace: open, unavailable: null };
  const first = workspaces[0];
  return {
    workspace: null,
    unavailable: first ? workspaceUnavailability(first, workspaces.length) : null,
  };
}

/**
 * The switcher at the top of the sidebar: the workspace, or on a build without
 * Switch Cloud the server, that the window is scoped to.
 *
 * With nothing to switch between it collapses to the one action that leads
 * anywhere.
 */
export const WorkspaceSwitcher = observer(function WorkspaceSwitcher() {
  const store = switchServersStore;
  const cloud = useSwitchCloud();

  useEffect(() => {
    void store.init();
    void localServerStore.init();
    void remoteServerStore.init();
    const onFocus = () => void store.recoverStale();
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      localServerStore.dispose();
      remoteServerStore.dispose();
    };
  }, [store]);

  const active = workspacesStore.active;
  const activeServer = active ? store.serverById(active.serverId) : null;

  if (!active || !activeServer) return <NoServerYet />;

  return showsServers(cloud.kind) ? (
    <ServerMenu activeServer={activeServer} />
  ) : (
    <WorkspaceMenu active={active} activeServer={activeServer} />
  );
});

const NoServerYet = observer(function NoServerYet() {
  const showAddServerModal = useShowModal('addServerModal');
  return (
    <div className="px-2">
      <LocalServerPendingButton />
      {localServerStore.phase === 'stopped' && (
        <button
          type="button"
          onClick={() => showAddServerModal({})}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-foreground-tertiary hover:bg-[var(--sel-soft)]"
        >
          <Plus className="size-4 shrink-0 text-foreground-muted" />
          Add a server
        </button>
      )}
    </div>
  );
});

/** One row per server, as the sidebar had before workspaces. */
const ServerMenu = observer(function ServerMenu({ activeServer }: { activeServer: SwitchServer }) {
  const store = switchServersStore;
  const { navigate } = useNavigate();
  const showAddServerModal = useShowModal('addServerModal');
  const ActiveIcon = serverIcon(activeServer);

  return (
    <div className="px-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Switch server"
              className="flex w-full items-center gap-[10px] rounded-lg px-2 py-1.5 text-left hover:bg-[var(--sel-soft)]"
            >
              <ServerAvatar server={activeServer} size="md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {activeServer.name}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-foreground-muted">
                  <ActiveIcon className="size-3 shrink-0" />
                  {activeServer.managed ? (
                    <>
                      <span className="truncate">{serverPlacementLabel(activeServer)}</span>
                      <ManagedServerDot server={activeServer} size={6} />
                    </>
                  ) : (
                    <ServerProblemDot server={activeServer} />
                  )}
                  <ChatsOfflineNote server={activeServer} />
                </span>
              </span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-foreground-muted" />
            </button>
          }
        />
        <DropdownMenuContent align="start" className="min-w-72">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs font-medium text-foreground-passive">
              Servers
            </DropdownMenuLabel>
            {store.servers.map((server) => (
              <ServerMenuItem
                key={server.id}
                server={server}
                active={server.id === activeServer.id}
              />
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => showAddServerModal({})}>
            <Plus className="size-4" />
            Add server
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* The welcome screen is what the app opens with before any server
              exists; once one does, this is how it stays reachable. */}
          <DropdownMenuItem onClick={() => navigate('home')}>
            <SwitchConsoleMark size={16} />
            About Switch
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});

/**
 * A server, opened by switching to its one workspace.
 *
 * A server with no workspace has not finished registering, and one whose only
 * workspace this account has lost cannot be opened; both stay listed, disabled
 * and saying why, for the same reasons the workspace menu keeps such rows.
 */
const ServerMenuItem = observer(function ServerMenuItem({
  server,
  active,
}: {
  server: SwitchServer;
  active: boolean;
}) {
  const { navigate } = useNavigate();
  const { toast } = useToast();
  const Icon = serverIcon(server);
  const placement = serverPlacementLabel(server);
  const drift = serverDrift(server);
  const { workspace, unavailable } = serverRowWorkspace(
    workspacesStore.onServer(server.id),
    workspacesStore.activeId
  );
  const reason = unavailable
    ? UNAVAILABLE_REASON[unavailable](server.name)
    : !workspace
      ? 'This server has not finished being set up.'
      : undefined;

  return (
    <DropdownMenuItem
      aria-current={active ? 'true' : undefined}
      className={cn(active && 'bg-[var(--sel)]')}
      disabled={reason !== undefined}
      title={reason}
      onClick={() => {
        if (!workspace) return;
        const dormant = serverAvailability(server.id) === 'dormant';
        void workspacesStore
          .setActive(workspace.id)
          .then(() => navigate(dormant ? 'managedServer' : 'server', { serverId: server.id }))
          .catch(() => {
            toast({
              title: 'Could not switch server',
              description: `${server.name} is still there; the app stayed where it was.`,
              variant: 'destructive',
            });
          });
      }}
    >
      <ServerAvatar server={server} size="md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{server.name}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground-muted">
          <Icon className="size-3 shrink-0" />
          {server.managed ? (
            <ManagedServerDot server={server} size={6} />
          ) : (
            <ServerProblemDot server={server} />
          )}
          {(placement || unavailable) && (
            <span className="shrink-0 rounded bg-background-tertiary px-1 py-px text-[10px] font-medium tracking-wide text-foreground-muted uppercase">
              {unavailable ? UNAVAILABLE_BADGE[unavailable] : placement}
            </span>
          )}
        </span>
      </span>
      {drift && !server.managed && <ServerDriftIndicator drift={drift} />}
    </DropdownMenuItem>
  );
});

// The workspace menu's rows, as one place to read the sizes off: workspace
// rows a little denser than the app's default menu row, action rows a fixed
// height, and the small buttons on a row light enough not to compete with it.
const WORKSPACE_ROW =
  'gap-2.5 rounded-[7px] px-[9px] py-[5px] text-[13px] focus:bg-[var(--sel-soft)]';
const ACTION_ROW =
  'h-[30px] gap-2.5 rounded-[7px] px-[9px] py-0 text-[13px] text-[var(--fg-action)] focus:bg-[var(--sel-soft)] [&_svg]:text-[var(--fg-icon)]';
const ROW_BUTTON =
  'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[6px] px-[9px] text-[11.5px] text-[var(--fg-action)] disabled:opacity-60';

/**
 * Workspaces listed under the server hosting them rather than in one flat
 * list. A workspace only means anything on its server — two servers can each
 * have a "Default" — and the server is also what carries reachability, so the
 * group heading is where it is said once instead of on every row.
 *
 * A search box at the top narrows the list by workspace or server name, for an
 * account in enough workspaces that scanning them stops being quick.
 */
const WorkspaceMenu = observer(function WorkspaceMenu({
  active,
  activeServer,
}: {
  active: Workspace;
  activeServer: SwitchServer;
}) {
  const store = switchServersStore;
  const { navigate } = useNavigate();
  const showAddServerModal = useShowModal('addServerModal');
  const [query, setQuery] = useState('');

  const noWorkspaceYet =
    active.tenantId === null &&
    serverAvailability(activeServer.id) === 'available' &&
    workspacesStore.hasNoMembership(activeServer.id);
  const anyMatch =
    query.trim() === '' ||
    store.servers.some(
      (server) =>
        matchesQuery(server.name, query) ||
        workspacesStore.onServer(server.id).some((w) => matchesQuery(w.name, query))
    );

  return (
    <div className="px-2">
      <DropdownMenu onOpenChange={(open) => !open && setQuery('')}>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Switch workspace"
              className="flex w-full items-center gap-[10px] rounded-[9px] px-2 py-1.5 text-left hover:bg-[var(--sel-soft)] data-[popup-open]:bg-[var(--sel-soft)]"
            >
              <WorkspaceAvatar name={active.name} size="md" active />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {noWorkspaceYet ? 'No workspace yet' : active.name}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-foreground-muted">
                  <span className="truncate">{activeServer.name}</span>
                  {activeServer.managed ? (
                    <ManagedServerDot server={activeServer} size={6} />
                  ) : (
                    <ServerProblemDot server={activeServer} />
                  )}
                  <ChatsOfflineNote server={activeServer} />
                </span>
              </span>
              <PendingInvitationCount server={activeServer} />
              <ChevronsUpDown className="size-3.5 shrink-0 text-foreground-muted" />
            </button>
          }
        />
        <DropdownMenuContent
          align="start"
          className="w-80 rounded-[var(--radius-elevated)] bg-[var(--menu-surface)] p-1.5 shadow-[var(--menu-shadow)] ring-[0.5px] ring-[var(--hair)]"
        >
          <WorkspaceSearch value={query} onChange={setQuery} />
          {store.servers.map((server) => (
            <ServerWorkspaceGroup key={server.id} server={server} query={query} />
          ))}
          {!anyMatch && (
            <div className="px-2 py-3 text-center text-xs text-foreground-muted">
              No workspace or server matches “{query.trim()}”.
            </div>
          )}
          <DropdownMenuSeparator className="mx-1 my-1.5 h-[0.5px] bg-[var(--hair)]" />
          {/* Create organization and Invite live with the server and the
              workspace they act on, so only what belongs to no server is left
              here. */}
          <DropdownMenuItem className={ACTION_ROW} onClick={() => showAddServerModal({})}>
            <Server className="size-4" />
            Add server…
          </DropdownMenuItem>
          {/* The welcome screen is what the app opens with before any server
              exists; once one does, this is how it stays reachable. */}
          <DropdownMenuItem className={ACTION_ROW} onClick={() => navigate('home')}>
            <SwitchConsoleMark size={16} />
            About Switch
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});

export function matchesQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === '' || name.toLowerCase().includes(q);
}

/**
 * The search box at the top of the menu.
 *
 * The menu reads typed letters as a jump to the item starting with them, so
 * keys typed here are kept from reaching it — all but the ones that move
 * through or leave the menu.
 */
function WorkspaceSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative px-1 pt-1 pb-1.5">
      <Search className="pointer-events-none absolute top-1/2 left-3.5 size-3.5 -translate-y-1/2 text-[var(--fg-dim)]" />
      <input
        autoFocus
        type="text"
        aria-label="Find a workspace"
        placeholder="Find a workspace…"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' && event.key !== 'ArrowDown' && event.key !== 'Tab') {
            event.stopPropagation();
          }
        }}
        className="h-[30px] w-full rounded-[7px] border-[0.5px] border-[var(--hair)] bg-[var(--menu-field)] pr-2 pl-8 text-[13px] text-[var(--fg-name)] outline-none placeholder:text-[var(--fg-dim)] focus:border-[var(--hair-strong)]"
      />
    </div>
  );
}

/**
 * A managed local stack that is starting has no server record yet, so it would
 * otherwise be invisible until it is healthy — and a failed setup invisible
 * forever.
 */
const LocalServerPendingButton = observer(function LocalServerPendingButton() {
  const showAddServerModal = useShowModal('addServerModal');
  const phase = localServerStore.phase;
  if (phase === 'stopped') return null;
  const failed = phase === 'error';

  return (
    <button
      type="button"
      onClick={() => showAddServerModal({ mode: 'local' })}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-foreground-tertiary hover:bg-[var(--sel-soft)]"
    >
      <span className="min-w-0 flex-1 truncate text-left">
        {failed ? 'Local server (setup failed)' : 'Local Switch server'}
      </span>
      <span
        aria-hidden
        className={cn('size-1.5 shrink-0 rounded-full', failed ? 'bg-red-500' : 'bg-amber-500')}
      />
      {phase === 'starting' && <Spinner className="size-3.5 shrink-0" />}
    </button>
  );
});

/** One server, as a heading over the workspaces the account has on it. */
const ServerWorkspaceGroup = observer(function ServerWorkspaceGroup({
  server,
  query,
}: {
  server: SwitchServer;
  query: string;
}) {
  // A server you are not signed in to cannot be asked about invitations, so
  // the hooks that ask only mount where it can.
  return serverAvailability(server.id) === 'available' ? (
    <AvailableServerWorkspaceGroup server={server} query={query} />
  ) : (
    <ServerWorkspaceGroupBody
      server={server}
      query={query}
      creation={NO_CREATION}
      invitations={NO_OFFERS.invitations}
      joinable={NO_OFFERS.joinable}
      invitationsFailed={false}
      joinableFailed={false}
    />
  );
});

const NO_OFFERS: { invitations: PendingInvitation[]; joinable: JoinableWorkspace[] } = {
  invitations: [],
  joinable: [],
};

/**
 * What the switcher offers to create on a server.
 *
 * `answer` is the server's own, for the workspace it was asked about; null
 * until it has answered, or where it could not be asked.
 */
type Creation = {
  canCreate: boolean;
  organizations: boolean;
  answer: CreationAnswer | null;
};

const NO_CREATION: Creation = { canCreate: false, organizations: false, answer: null };

function AvailableServerWorkspaceGroup({ server, query }: { server: SwitchServer; query: string }) {
  const invitations = usePendingInvitations(server.id);
  const joinable = useJoinableWorkspaces(server.id);
  // The server's own answer, so Create organization is not offered where
  // creating one is refused: a deployment that keeps to one workspace,
  // invite-only sign-up, or a spent allowance. Offered until it has said no.
  const answer = useQuery({
    queryKey: ['workspace-creation', server.id],
    queryFn: () => rpc.switchServers.workspaceCreation(server.id),
    staleTime: 60_000,
  });
  const creation: Creation = answer.data
    ? {
        canCreate: answer.data.canCreate,
        organizations: answer.data.organizations,
        answer: answer.data,
      }
    : {
        canCreate: true,
        organizations: workspacesStore.onServer(server.id).some((w) => w.organizationId !== null),
        answer: null,
      };
  return (
    <ServerWorkspaceGroupBody
      server={server}
      query={query}
      creation={creation}
      invitations={listedInvitations(invitations.data)}
      joinable={listedJoinable(joinable.data)}
      invitationsFailed={invitations.isError}
      joinableFailed={joinable.isError}
    />
  );
}

const ServerWorkspaceGroupBody = observer(function ServerWorkspaceGroupBody({
  server,
  query,
  creation,
  invitations,
  joinable,
  invitationsFailed,
  joinableFailed,
}: {
  server: SwitchServer;
  query: string;
  creation: Creation;
  invitations: PendingInvitation[];
  joinable: JoinableWorkspace[];
  invitationsFailed: boolean;
  joinableFailed: boolean;
}) {
  const { navigate } = useNavigate();
  const { toast } = useToast();
  const showCreateWorkspaceModal = useShowModal('createWorkspaceModal');
  const Icon = serverIcon(server);
  const drift = serverDrift(server);
  const searching = query.trim() !== '';
  // A search for the server's own name keeps all of its rows, since that is
  // the quickest way to say "the ones on that server".
  const whole = !searching || matchesQuery(server.name, query);
  const all = workspacesStore.onServer(server.id);
  const availability = serverAvailability(server.id);
  const signedOut = availability === 'signed-out';
  const noMembership = availability === 'available' && workspacesStore.hasNoMembership(server.id);
  // The row a server is registered with names no workspace until sign-in
  // matches it to one. Signed out, or signed in to an account that belongs to
  // none, it would read as a workspace called after the server that does not
  // exist there, so it gives way to what can actually be done.
  const placeholder = all.find((w) => w.tenantId === null) ?? null;
  const hidePlaceholder = signedOut || noMembership;
  const listed = hidePlaceholder ? all.filter((w) => w.tenantId !== null) : all;
  const workspaces = whole ? listed : listed.filter((w) => matchesQuery(w.name, query));
  const signInTarget = placeholder ?? all[0] ?? null;
  const openForSignIn = () => {
    if (!signInTarget) return;
    void workspacesStore
      .setActive(signInTarget.id)
      .then(() => navigate('server', { serverId: server.id }))
      .catch(() => {
        toast({
          title: `Could not open ${server.name}`,
          description: 'The app stayed where it was.',
          variant: 'destructive',
        });
      });
  };
  const shownInvitations = whole
    ? invitations
    : invitations.filter((i) => matchesQuery(i.workspaceName, query));
  const shownJoinable = whole
    ? joinable
    : joinable.filter((j) => matchesQuery(j.workspaceName, query));
  const extraRows = (signedOut && signInTarget) || noMembership;
  const dormant = server.managed && availability === 'dormant';
  // Collapsed to one row, a server not usable here is found by its own name.
  if (searching && !whole && availability !== 'available' && !dormant) return null;
  if (
    searching &&
    !(whole && extraRows) &&
    workspaces.length + shownInvitations.length + shownJoinable.length === 0
  ) {
    return null;
  }
  const available = availability === 'available';
  const create = (target: CreateTarget) =>
    showCreateWorkspaceModal({
      serverId: server.id,
      target,
      onSuccess: (workspace) => navigate('server', { serverId: workspace.serverId }),
    });
  const groups = groupByOrganization(workspaces);
  // Headed only where there is more than one to tell apart.
  const headed = groups.length > 1;

  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel className="flex items-center gap-1.5 px-[9px] pt-2.5 pb-1 text-[10.5px] font-semibold tracking-[0.06em] text-[var(--fg-passive)] uppercase">
        <Icon className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{server.name}</span>
        {server.managed ? (
          <ManagedServerDot server={server} size={6} />
        ) : (
          drift && <ServerDriftIndicator drift={drift} />
        )}
      </DropdownMenuLabel>
      {/* A server this window cannot use right now collapses to one row that
          says why and offers the one thing that changes it: its workspaces
          cannot be opened from here until then, so listing them would only
          offer clicks that fail. */}
      {dormant ? (
        // Workspaces on a server this Console runs stay listed while it is not
        // running — dimmed, and opening onto the server's page, where it can be
        // started.
        workspaces.map((workspace) => (
          <WorkspaceMenuItem
            key={workspace.id}
            workspace={workspace}
            server={server}
            onServerCount={all.length}
            dormant
          />
        ))
      ) : !available ? (
        whole && (
          <UnavailableServerRow server={server} onSignIn={signInTarget ? openForSignIn : null} />
        )
      ) : (
        <>
          {noMembership && whole && (
            <div className="px-2 py-1.5 text-xs text-foreground-muted">
              {creation.canCreate
                ? creation.organizations
                  ? 'No workspace yet — create an organization, or accept an invitation below.'
                  : 'No workspace yet — create one, or accept an invitation below.'
                : 'No workspace yet — accept an invitation below.'}
            </div>
          )}
          {all.length === 0 ? (
            // Registering a server is what creates its first workspace, so a
            // server with none did not finish being registered. Saying so beats
            // an empty heading, which reads as a rendering fault.
            <div className="px-2 py-1.5 text-xs text-foreground-muted">
              No workspace yet — this server has not finished being set up.
            </div>
          ) : (
            groups.map((group) => {
              const through = whole ? addWorkspaceThrough(group, all, creation.answer) : null;
              return (
                <Fragment key={group.organizationId ?? 'none'}>
                  {headed && (
                    <div
                      data-org-heading
                      className="truncate px-[9px] pt-1.5 pb-0.5 text-[11px] font-medium text-[var(--fg-dim)]"
                    >
                      {group.name ?? 'Other workspaces'}
                    </div>
                  )}
                  {group.workspaces.map((workspace) => (
                    <WorkspaceMenuItem
                      key={workspace.id}
                      workspace={workspace}
                      server={server}
                      onServerCount={all.length}
                      dormant={false}
                    />
                  ))}
                  {through && (
                    <DropdownMenuItem
                      onClick={() =>
                        create({
                          kind: 'organization-workspace',
                          through: through.id,
                          organizationName: group.name,
                        })
                      }
                      className={cn(ACTION_ROW, 'text-[var(--fg-dim)]')}
                    >
                      <Plus className="size-4" />
                      {headed || group.name === null
                        ? 'Add workspace'
                        : `Add workspace to ${group.name}`}
                    </DropdownMenuItem>
                  )}
                </Fragment>
              );
            })
          )}
          {invitationsFailed && (
            <div className="px-2 py-1.5 text-xs text-foreground-muted">
              Could not check for invitations to your address.
            </div>
          )}
          {shownInvitations.map((invitation) => (
            <PendingInvitationMenuItem
              key={invitation.id}
              invitation={invitation}
              server={server}
            />
          ))}
          {joinableFailed && (
            <div className="px-2 py-1.5 text-xs text-foreground-muted">
              Could not check for workspaces open to your e-mail domain.
            </div>
          )}
          {shownJoinable.map((offer) => (
            <JoinableWorkspaceMenuItem key={offer.tenantId} offer={offer} server={server} />
          ))}
          {whole && creation.canCreate && (
            <DropdownMenuItem
              onClick={() =>
                create({ kind: creation.organizations ? 'organization' : 'workspace' })
              }
              className={cn(ACTION_ROW, 'text-[var(--fg-dim)]')}
            >
              <Plus className="size-4" />
              {creation.organizations ? 'Create organization' : 'New workspace'}
            </DropdownMenuItem>
          )}
        </>
      )}
    </DropdownMenuGroup>
  );
});

/**
 * A server whose workspaces cannot be opened from here right now, as one row:
 * its state, and the button that changes it — Start for a stack this Console
 * runs that is stopped, Sign in for a server it is signed out of.
 */
const UnavailableServerRow = observer(function UnavailableServerRow({
  server,
  onSignIn,
}: {
  server: SwitchServer;
  onSignIn: (() => void) | null;
}) {
  const state = serverState(server);
  const remoteHost = server.managementKind === 'remote' ? server.sshHost : null;
  const starting = remoteHost
    ? remoteServerStore.isTransitioning(remoteHost)
    : localServerStore.isTransitioning;
  const start = () =>
    void (remoteHost ? remoteServerStore.start(remoteHost, server.name) : localServerStore.start());
  const action =
    state === 'not-running'
      ? { label: starting ? 'Starting…' : 'Start', onClick: start, disabled: starting }
      : state === 'signed-out' && onSignIn
        ? { label: 'Sign in', onClick: onSignIn, disabled: false }
        : null;

  return (
    <div className="flex h-[30px] items-center rounded-[7px] bg-[var(--menu-faint)] pr-1 text-[12.5px] text-[var(--fg-dim)]">
      <span className="mx-2 flex shrink-0 items-center">
        <ServerStatusDot server={server} />
      </span>
      <span className="min-w-0 flex-1 truncate">{serverStatusLabel(server)}</span>
      {action && (
        <button
          type="button"
          className={cn(ROW_BUTTON, 'border-[0.5px] border-[var(--hair-strong)] bg-transparent')}
          disabled={action.disabled}
          onClick={(event) => {
            event.stopPropagation();
            action.onClick();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
});

const UNAVAILABLE_BADGE: Record<WorkspaceUnavailability, string> = {
  withdrawn: 'No longer a member',
  unmatched: 'Not matched',
};

/**
 * What to do about a workspace that cannot be opened — said on the row rather
 * than after the click, since the app already knows.
 *
 * The unmatched case deliberately does not say "sign in again": signing in
 * re-runs the reconcile, which is what left the row unmatched, and would do so
 * again. The row only survives because it holds agents, so the way out is the
 * workspace beside it plus adding those agents there.
 */
const UNAVAILABLE_REASON: Record<WorkspaceUnavailability, (name: string) => string> = {
  withdrawn: (name) =>
    `This account is no longer a member of ${name}. Its agents are still here; ask an admin to add you back to open it.`,
  unmatched: (name) =>
    `${name} was never matched to a workspace on this server, so there is no way to tell which one to ask for. Open one of the others; the agents left here have to be added again in the workspace they belong to.`,
};

const WorkspaceMenuItem = observer(function WorkspaceMenuItem({
  workspace,
  server,
  onServerCount,
  dormant,
}: {
  workspace: Workspace;
  server: SwitchServer;
  onServerCount: number;
  /** Its server is managed here and not running: dimmed, and opens the
   * server's page rather than the workspace's home. */
  dormant: boolean;
}) {
  const { navigate } = useNavigate();
  const { toast } = useToast();
  const showInvitePeopleModal = useShowModal('invitePeopleModal');
  const isActive = workspacesStore.activeId === workspace.id;
  // Kept in the list rather than hidden: its agents are still here and the row
  // is the only thing that says where they went. Disabled, because the gateway
  // refuses every call scoped to it — offering it would turn a fact the app
  // already knows into an error after the click.
  const unavailable = workspaceUnavailability(workspace, onServerCount);
  // Not offered on a server running on this computer: nobody elsewhere can
  // reach it, so an invitation would lead them nowhere.
  const canInvite =
    !dormant &&
    unavailable === null &&
    administersWorkspace(workspace) &&
    !runsOnThisComputer(server);

  return (
    <DropdownMenuItem
      // The active workspace is filled and ticked, so the row you are on reads
      // at a glance. `aria-current` carries the same fact for anything that
      // cannot see either.
      aria-current={isActive ? 'true' : undefined}
      className={cn('group/ws', WORKSPACE_ROW, isActive && 'bg-[var(--sel-soft)]')}
      disabled={unavailable !== null}
      title={unavailable ? UNAVAILABLE_REASON[unavailable](workspace.name) : undefined}
      onClick={() => {
        void workspacesStore
          .setActive(workspace.id)
          .then(() => navigate(dormant ? 'managedServer' : 'server', { serverId: server.id }))
          .catch(() => {
            // Said out loud rather than swallowed: the sidebar would otherwise
            // keep showing the workspace you left, under the name of the one
            // you picked.
            toast({
              title: 'Could not switch workspace',
              description: `${workspace.name} is still there; the app stayed where it was.`,
              variant: 'destructive',
            });
          });
      }}
    >
      <span className={cn('flex shrink-0', dormant && 'opacity-50')}>
        <WorkspaceAvatar name={workspace.name} size="tile" active={isActive && !dormant} />
      </span>
      <span
        data-row-name
        className={cn(
          'min-w-0 flex-1 truncate',
          dormant ? 'text-[var(--fg-dim)]' : 'text-[var(--fg-name)]'
        )}
      >
        {workspace.name}
      </span>
      {unavailable && (
        <span className="shrink-0 rounded bg-background-tertiary px-1 py-px text-[10px] font-medium tracking-wide text-foreground-muted uppercase">
          {UNAVAILABLE_BADGE[unavailable]}
        </span>
      )}
      {/* Shown on the open workspace and on the row under the pointer, and only where the gateway would
          take it: it refuses members, and a button that always ends in a 403
          is a trap. */}
      {canInvite && (
        <button
          type="button"
          className={cn(
            ROW_BUTTON,
            'bg-[var(--menu-pill)]',
            !isActive &&
              'opacity-0 group-hover/ws:opacity-100 group-data-[highlighted]/ws:opacity-100 focus-visible:opacity-100'
          )}
          onClick={(event) => {
            event.stopPropagation();
            showInvitePeopleModal({ workspaceId: workspace.id });
          }}
        >
          <UserPlus className="size-3" />
          Invite
        </button>
      )}
      {isActive && !canInvite && <Check className="size-3.5 shrink-0 text-[var(--fg-icon)]" />}
    </DropdownMenuItem>
  );
});

/**
 * How many invitations are waiting on the server you are in, on the switcher
 * button itself — the rows are behind the menu, and nothing else would say
 * they are there.
 */
const PendingInvitationCount = observer(function PendingInvitationCount({
  server,
}: {
  server: SwitchServer;
}) {
  if (serverAvailability(server.id) !== 'available') return null;
  return <PendingInvitationCountBadge serverId={server.id} />;
});

function PendingInvitationCountBadge({ serverId }: { serverId: string }) {
  const count = listedInvitations(usePendingInvitations(serverId).data).length;
  if (count === 0) return null;
  return (
    <span
      aria-label={count === 1 ? '1 invitation waiting' : `${count} invitations waiting`}
      className="bg-primary text-primary-foreground flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold"
    >
      {count}
    </span>
  );
}

function PendingInvitationMenuItem({
  invitation,
  server,
}: {
  invitation: PendingInvitation;
  server: SwitchServer;
}) {
  const { navigate } = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  return (
    <DropdownMenuItem
      title={invitationSummary(invitation)}
      className={WORKSPACE_ROW}
      data-testid="pending-invitation-item"
      onClick={() => {
        void workspacesStore
          .acceptPendingInvitation(server.id, invitation)
          .then((workspace) => workspacesStore.setActive(workspace.id))
          .then(() => navigate('server', { serverId: server.id }))
          .catch((cause: unknown) => {
            toast({
              title: `Could not join ${invitation.workspaceName}`,
              description: failureText(cause, 'The invitation is still waiting.'),
              variant: 'destructive',
            });
          })
          .finally(
            () => void queryClient.invalidateQueries({ queryKey: pendingInvitationsKey(server.id) })
          );
      }}
    >
      <WorkspaceAvatar name={invitation.workspaceName} size="tile" />
      <span data-row-name className="min-w-0 flex-1 truncate text-[var(--fg-name)]">
        {invitation.workspaceName}
      </span>
      <InvitedBadge />
    </DropdownMenuItem>
  );
}

function JoinableWorkspaceMenuItem({
  offer,
  server,
}: {
  offer: JoinableWorkspace;
  server: SwitchServer;
}) {
  const { navigate } = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  return (
    <DropdownMenuItem
      title={joinableSummary(offer)}
      className={WORKSPACE_ROW}
      data-testid="joinable-workspace-item"
      onClick={() => {
        void workspacesStore
          .joinByDomain(server.id, offer)
          .then((workspace) => workspacesStore.setActive(workspace.id))
          .then(() => navigate('server', { serverId: server.id }))
          .catch((cause: unknown) => {
            toast({
              title: `Could not join ${offer.workspaceName}`,
              description: failureText(cause, 'Joining failed.'),
              variant: 'destructive',
            });
          })
          .finally(
            () => void queryClient.invalidateQueries({ queryKey: joinableWorkspacesKey(server.id) })
          );
      }}
    >
      <WorkspaceAvatar name={offer.workspaceName} size="tile" />
      <span data-row-name className="min-w-0 flex-1 truncate text-[var(--fg-name)]">
        {offer.workspaceName}
      </span>
      <span className="shrink-0 text-xs font-medium text-foreground-muted">Join</span>
    </DropdownMenuItem>
  );
}
