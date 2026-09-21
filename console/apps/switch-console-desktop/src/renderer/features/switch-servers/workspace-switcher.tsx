import { ChevronsUpDown, Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
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
import { isWithdrawnWorkspace, type Workspace } from '@shared/core/workspaces/workspaces';
import { localServerStore } from './local-server-store';
import { remoteServerStore } from './remote-server-store';
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

/**
 * How the button names where you are.
 *
 * A server registered before its workspaces were known named its only workspace
 * after itself, so in the ordinary single-workspace case the two names are the
 * same and saying both would read as a stutter. Where they differ the server is
 * the more important half of the answer — the same workspace name can exist on
 * two of them.
 */
function switcherSubtitle(workspace: Workspace, server: SwitchServer): string {
  const status = serverSubtitleLabel(server);
  return workspace.name === server.name ? status : `${server.name} · ${status}`;
}

/**
 * The workspace switcher at the top of the sidebar.
 *
 * The window is scoped to one workspace: the sidebar, its sessions and
 * everything under them show that workspace's world and nothing else, so
 * exactly one is on screen at a time and the rest live behind this control.
 *
 * Workspaces are listed under the server hosting them rather than in one flat
 * list. A workspace only means anything on its server — two servers can each
 * have a "Default" — and the server is also what carries reachability, so the
 * group heading is where it is said once instead of on every row.
 *
 * With no workspace there is nothing to switch between, so it collapses to the
 * one action that leads anywhere.
 */
export const WorkspaceSwitcher = observer(function WorkspaceSwitcher() {
  const store = switchServersStore;
  const { navigate } = useNavigate();
  const showAddServerModal = useShowModal('addServerModal');

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

  if (!active || !activeServer) {
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
  }

  const ActiveIcon = serverIcon(activeServer);
  const drift = serverDrift(activeServer);

  return (
    <div className="px-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Switch workspace"
              className="flex w-full items-center gap-[10px] rounded-lg px-2 py-1.5 text-left hover:bg-[var(--sel-soft)]"
            >
              <ServerAvatar server={activeServer} size="md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {active.name}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-foreground-muted">
                  <ActiveIcon className="size-3 shrink-0" />
                  <span className="truncate">{switcherSubtitle(active, activeServer)}</span>
                  <ServerStatusDot server={activeServer} />
                  {drift && <ServerDriftIndicator drift={drift} />}
                </span>
              </span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-foreground-muted" />
            </button>
          }
        />
        <DropdownMenuContent align="start" className="min-w-72">
          {store.servers.map((server) => (
            <ServerWorkspaceGroup key={server.id} server={server} />
          ))}
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
}: {
  server: SwitchServer;
}) {
  const Icon = serverIcon(server);
  const placement = serverPlacementLabel(server);
  const drift = serverDrift(server);
  const workspaces = workspacesStore.onServer(server.id);

  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel className="flex items-center gap-2 py-1.5">
        <ServerAvatar server={server} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-foreground">{server.name}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs font-normal text-foreground-muted">
            <Icon className="size-3 shrink-0" />
            <span className="truncate">{serverStatusLabel(server)}</span>
            {/* Beside the words it qualifies rather than at the row's right edge,
                where it read as a property of the row instead of of the status. */}
            <ServerStatusDot server={server} />
            {placement && (
              <span className="shrink-0 rounded bg-background-tertiary px-1 py-px text-[10px] font-medium tracking-wide text-foreground-muted uppercase">
                {placement}
              </span>
            )}
          </span>
        </span>
        {drift && <ServerDriftIndicator drift={drift} />}
      </DropdownMenuLabel>
      {workspaces.length === 0 ? (
        // Registering a server is what creates its first workspace, so a server
        // with none did not finish being registered. Saying so beats an empty
        // heading, which reads as a rendering fault.
        <div className="px-2 py-1.5 pl-9 text-xs text-foreground-muted">
          No workspace yet — this server has not finished being set up.
        </div>
      ) : (
        workspaces.map((workspace) => (
          <WorkspaceMenuItem key={workspace.id} workspace={workspace} server={server} />
        ))
      )}
    </DropdownMenuGroup>
  );
});

const WorkspaceMenuItem = observer(function WorkspaceMenuItem({
  workspace,
  server,
}: {
  workspace: Workspace;
  server: SwitchServer;
}) {
  const { navigate } = useNavigate();
  const { toast } = useToast();
  const isActive = workspacesStore.activeId === workspace.id;
  // Kept in the list rather than hidden: its agents are still here and the row
  // is the only thing that says where they went. Disabled, because the gateway
  // refuses every call scoped to it — offering it would turn a fact the app
  // already knows into an error after the click.
  const withdrawn = isWithdrawnWorkspace(workspace);

  return (
    <DropdownMenuItem
      // The active workspace is shown by filling its row rather than by a tick
      // in the right margin, so the row you are on reads at a glance instead of
      // needing the eye to travel to the end of it. `aria-current` carries the
      // same fact for anything that cannot see the fill.
      aria-current={isActive ? 'true' : undefined}
      className={cn('pl-9', isActive && 'bg-[var(--sel)]')}
      disabled={withdrawn}
      title={
        withdrawn
          ? `This account is no longer a member of ${workspace.name}. Its agents are still here; ask an admin to add you back to open it.`
          : undefined
      }
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
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{workspace.name}</span>
      {(withdrawn || workspace.role) && (
        <span className="shrink-0 rounded bg-background-tertiary px-1 py-px text-[10px] font-medium tracking-wide text-foreground-muted uppercase">
          {withdrawn ? 'No longer a member' : workspace.role}
        </span>
      )}
    </DropdownMenuItem>
  );
});
