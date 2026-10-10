import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronsUpDown, LogIn, Plus, Search, Server, UserPlus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
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
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import type { JoinableWorkspace, PendingInvitation } from '@shared/core/workspaces/invitations';
import {
  administersWorkspace,
  type Workspace,
  type WorkspaceUnavailability,
  workspaceUnavailability,
} from '@shared/core/workspaces/workspaces';
import { localServerStore } from './local-server-store';
import { remoteServerStore } from './remote-server-store';
import { serverAvailability } from './server-availability';
import { serverIcon } from './server-icon';
import {
  ServerAvatar,
  ServerDriftIndicator,
  ServerStatusDot,
  serverDrift,
  serverPlacementLabel,
  serverStatusLabel,
  serverSubtitleLabel,
} from './server-presentation';
import { switchServersStore } from './switch-servers-store';
import { type SwitchCloudAvailability, useSwitchCloud } from './use-switch-cloud';

/**
 * How the button names where you are.
 *
 * A server registered before its workspaces are known names its only workspace
 * after itself, and until the account has been asked the two names are the same
 * — saying both would read as a stutter. Where they differ the server is the
 * more important half of the answer, since the same workspace name can exist on
 * two of them.
 */
function switcherSubtitle(workspace: Workspace, server: SwitchServer): string {
  const status = serverSubtitleLabel(server);
  return workspace.name === server.name ? status : `${server.name} · ${status}`;
}

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
  const drift = serverDrift(activeServer);

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
                  <span className="truncate">{serverSubtitleLabel(activeServer)}</span>
                  <ServerStatusDot server={activeServer} />
                  {drift && <ServerDriftIndicator drift={drift} />}
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
        void workspacesStore
          .setActive(workspace.id)
          .then(() => navigate('server', { serverId: server.id }))
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
          <span className="truncate">{serverStatusLabel(server)}</span>
          <ServerStatusDot server={server} />
          {(placement || unavailable) && (
            <span className="shrink-0 rounded bg-background-tertiary px-1 py-px text-[10px] font-medium tracking-wide text-foreground-muted uppercase">
              {unavailable ? UNAVAILABLE_BADGE[unavailable] : placement}
            </span>
          )}
        </span>
      </span>
      {drift && <ServerDriftIndicator drift={drift} />}
    </DropdownMenuItem>
  );
});

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
  const showCreateWorkspaceModal = useShowModal('createWorkspaceModal');
  const showInvitePeopleModal = useShowModal('invitePeopleModal');
  const [query, setQuery] = useState('');

  const drift = serverDrift(activeServer);
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
              className="flex w-full items-center gap-[10px] rounded-lg px-2 py-1.5 text-left hover:bg-[var(--sel-soft)]"
            >
              <WorkspaceAvatar name={active.name} size="md" active />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {noWorkspaceYet ? 'No workspace yet' : active.name}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-foreground-muted">
                  <span className="truncate">
                    {noWorkspaceYet ? activeServer.name : switcherSubtitle(active, activeServer)}
                  </span>
                  <ServerStatusDot server={activeServer} />
                  {drift && <ServerDriftIndicator drift={drift} />}
                </span>
              </span>
              <PendingInvitationCount server={activeServer} />
              <ChevronsUpDown className="size-3.5 shrink-0 text-foreground-muted" />
            </button>
          }
        />
        <DropdownMenuContent align="start" className="w-80">
          <WorkspaceSearch value={query} onChange={setQuery} />
          {store.servers.map((server) => (
            <ServerWorkspaceGroup key={server.id} server={server} query={query} />
          ))}
          {!anyMatch && (
            <div className="px-2 py-3 text-center text-xs text-foreground-muted">
              No workspace or server matches “{query.trim()}”.
            </div>
          )}
          <DropdownMenuSeparator />
          {/* Offered only where the gateway would take it: it refuses members,
              and a menu item that always ends in a 403 is a trap. */}
          {administersWorkspace(active) && (
            <DropdownMenuItem onClick={() => showInvitePeopleModal({ workspaceId: active.id })}>
              <UserPlus className="size-4" />
              Invite people to {active.name}…
            </DropdownMenuItem>
          )}
          {/* Above Add server because it is the commoner errand by far: you add
              a server once and make workspaces on it for as long as you use
              it. It opens on the server you are already in — the modal asks
              which only where there is more than one to ask about. */}
          <DropdownMenuItem
            onClick={() =>
              showCreateWorkspaceModal({
                serverId: activeServer.id,
                onSuccess: (workspace) => navigate('server', { serverId: workspace.serverId }),
              })
            }
          >
            <Plus className="size-4" />
            New workspace…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => showAddServerModal({})}>
            <Server className="size-4" />
            Add server…
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
      <Search className="pointer-events-none absolute top-1/2 left-3.5 size-3.5 -translate-y-1/2 text-foreground-muted" />
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
        className="h-8 w-full rounded-md border border-border bg-background-tertiary pr-2 pl-8 text-sm text-foreground outline-none placeholder:text-foreground-muted focus:border-foreground-muted"
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

function AvailableServerWorkspaceGroup({ server, query }: { server: SwitchServer; query: string }) {
  const invitations = usePendingInvitations(server.id);
  const joinable = useJoinableWorkspaces(server.id);
  return (
    <ServerWorkspaceGroupBody
      server={server}
      query={query}
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
  invitations,
  joinable,
  invitationsFailed,
  joinableFailed,
}: {
  server: SwitchServer;
  query: string;
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
  if (
    searching &&
    !(whole && extraRows) &&
    workspaces.length + shownInvitations.length + shownJoinable.length === 0
  ) {
    return null;
  }
  const available = availability === 'available';

  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel className="flex items-center gap-1.5 px-2 pt-2.5 pb-1 text-[11px] font-semibold tracking-wide text-foreground-muted uppercase">
        <Icon className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{server.name}</span>
        {/* Said only when something is wrong: a heading for every server that
            is fine would be noise on each of them. */}
        {!available && (
          <>
            <ServerStatusDot server={server} />
            <span className="shrink-0 font-normal tracking-normal normal-case">
              {serverStatusLabel(server)}
            </span>
          </>
        )}
        {drift && <ServerDriftIndicator drift={drift} />}
      </DropdownMenuLabel>
      {signedOut && signInTarget && whole && (
        <DropdownMenuItem onClick={openForSignIn}>
          <LogIn className="size-4" />
          Sign in…
        </DropdownMenuItem>
      )}
      {noMembership && whole && (
        <>
          <div className="px-2 py-1.5 text-xs text-foreground-muted">
            No workspace yet — create one, or accept an invitation below.
          </div>
          <DropdownMenuItem
            onClick={() =>
              showCreateWorkspaceModal({
                serverId: server.id,
                onSuccess: (workspace) => navigate('server', { serverId: workspace.serverId }),
              })
            }
          >
            <Plus className="size-4" />
            Create a workspace…
          </DropdownMenuItem>
        </>
      )}
      {all.length === 0 ? (
        // Registering a server is what creates its first workspace, so a server
        // with none did not finish being registered. Saying so beats an empty
        // heading, which reads as a rendering fault.
        <div className="px-2 py-1.5 text-xs text-foreground-muted">
          No workspace yet — this server has not finished being set up.
        </div>
      ) : (
        workspaces.map((workspace) => (
          <WorkspaceMenuItem
            key={workspace.id}
            workspace={workspace}
            server={server}
            onServerCount={all.length}
          />
        ))
      )}
      {available && (
        <>
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
        </>
      )}
    </DropdownMenuGroup>
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
}: {
  workspace: Workspace;
  server: SwitchServer;
  onServerCount: number;
}) {
  const { navigate } = useNavigate();
  const { toast } = useToast();
  const isActive = workspacesStore.activeId === workspace.id;
  // Kept in the list rather than hidden: its agents are still here and the row
  // is the only thing that says where they went. Disabled, because the gateway
  // refuses every call scoped to it — offering it would turn a fact the app
  // already knows into an error after the click.
  const unavailable = workspaceUnavailability(workspace, onServerCount);

  return (
    <DropdownMenuItem
      // The active workspace is filled and ticked, so the row you are on reads
      // at a glance. `aria-current` carries the same fact for anything that
      // cannot see either.
      aria-current={isActive ? 'true' : undefined}
      className={cn(isActive && 'bg-[var(--sel)]')}
      disabled={unavailable !== null}
      title={unavailable ? UNAVAILABLE_REASON[unavailable](workspace.name) : undefined}
      onClick={() => {
        void workspacesStore
          .setActive(workspace.id)
          .then(() => navigate('server', { serverId: server.id }))
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
      <WorkspaceAvatar name={workspace.name} size="sm" active={isActive} />
      <span data-row-name className="min-w-0 flex-1 truncate text-sm text-foreground">
        {workspace.name}
      </span>
      {unavailable && (
        <span className="shrink-0 rounded bg-background-tertiary px-1 py-px text-[10px] font-medium tracking-wide text-foreground-muted uppercase">
          {UNAVAILABLE_BADGE[unavailable]}
        </span>
      )}
      {isActive && <Check className="size-4 shrink-0 text-foreground" />}
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
      <WorkspaceAvatar name={invitation.workspaceName} size="sm" />
      <span data-row-name className="min-w-0 flex-1 truncate text-sm text-foreground">
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
      <WorkspaceAvatar name={offer.workspaceName} size="sm" />
      <span data-row-name className="min-w-0 flex-1 truncate text-sm text-foreground">
        {offer.workspaceName}
      </span>
      <span className="shrink-0 text-xs font-medium text-foreground-muted">Join</span>
    </DropdownMenuItem>
  );
}
