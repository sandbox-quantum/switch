import {
  ArrowUpCircle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Globe,
  HardDrive,
  Pencil,
  Plus,
  Server,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { isCurrentView, useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { buttonVariants } from '@renderer/lib/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/lib/ui/context-menu';
import { MicroLabel } from '@renderer/lib/ui/label';
import { Spinner } from '@renderer/lib/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import type { SwitchVersionDrift } from '@shared/core/managed-switch-server/managed-switch-server';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { SidebarMenu, SidebarMenuButton } from '../sidebar/sidebar-primitives';
import { localServerStore } from './local-server-store';
import { remoteServerStore } from './remote-server-store';
import { serverAvailability } from './server-availability';
import { switchServersStore } from './switch-servers-store';

export const ServersSidebarSection = observer(function ServersSidebarSection() {
  const store = switchServersStore;
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

  // Adding a server — local or remote — is reached from the header's "+" only.
  // A managed server still gets a placeholder row while it starts, so the list
  // shows it before the record exists.
  const hasManagedServer = store.servers.some((s) => s.managed);
  // The selected server scopes the whole sidebar. When the list is collapsed the
  // rows are hidden, so surface the active server's name here to keep it clear
  // which server is selected in any context.
  const activeServer = store.servers.find((s) => s.id === store.activeServerId);

  return (
    <div className="flex flex-col">
      <div className="flex h-[40px] items-center justify-between pr-2.5 pl-2">
        <button
          type="button"
          onClick={() => store.toggleServersExpanded()}
          className="flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-foreground-tertiary-passive hover:text-foreground-tertiary"
          aria-label={store.serversExpanded ? 'Collapse servers' : 'Expand servers'}
        >
          {store.serversExpanded ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" />
          )}
          <MicroLabel className="text-foreground-tertiary-passive">Servers</MicroLabel>
          {!store.serversExpanded && activeServer && (
            <span className="min-w-0 truncate text-xs font-medium text-foreground-muted">
              · {activeServer.name}
            </span>
          )}
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => showAddServerModal({})}
                aria-label="Add server"
                className={buttonVariants({
                  size: 'icon-xs',
                  variant: 'ghost',
                  className: 'hover:bg-transparent text-foreground-muted hover:text-foreground',
                })}
              >
                <Plus />
              </button>
            }
          />
          <TooltipContent>Add server</TooltipContent>
        </Tooltip>
      </div>

      {store.serversExpanded && (
        <SidebarMenu className="px-2 pb-1">
          {store.servers.map((server) => (
            <ServerEntry key={server.id} serverId={server.id} />
          ))}
          {/* Before the managed record exists (still pulling/starting, or a
              failed attempt), show a placeholder entry so the local server is
              always visible in the list — not only once it's healthy. */}
          {!hasManagedServer && localServerStore.phase !== 'stopped' && (
            <LocalServerPendingEntry onOpen={() => showAddServerModal({ mode: 'local' })} />
          )}
        </SidebarMenu>
      )}
    </div>
  );
});

const LocalServerPendingEntry = observer(function LocalServerPendingEntry({
  onOpen,
}: {
  onOpen: () => void;
}) {
  const phase = localServerStore.phase;
  const failed = phase === 'error';
  return (
    <SidebarMenuButton onClick={onOpen} className="justify-between">
      <span className="flex min-w-0 items-center gap-2">
        <HardDrive className="size-4 shrink-0" />
        <span className="truncate">
          {failed ? 'Local server (setup failed)' : 'Local Switch server'}
        </span>
        <span
          aria-hidden
          className={cn('size-1.5 shrink-0 rounded-full', failed ? 'bg-red-500' : 'bg-amber-500')}
        />
      </span>
      {phase === 'starting' && <Spinner className="size-3.5 shrink-0" />}
    </SidebarMenuButton>
  );
});

/**
 * Flags a managed server whose switch-core no longer matches the version this
 * build pins (CHOO-1736), so an available update is visible from the sidebar
 * rather than only on the server's own page.
 *
 * Sits beside the connection dot rather than recolouring it: the dot answers
 * "can I reach this server", which stays true of a server running a stale core.
 */
function ServerDriftIndicator({ drift }: { drift: SwitchVersionDrift }) {
  const upgrade = drift.direction === 'upgrade';
  const label = upgrade
    ? `switch-core ${drift.expected} is available (running ${drift.deployed})`
    : drift.direction === 'downgrade'
      ? `Runs switch-core ${drift.deployed} — newer than this app expects (${drift.expected})`
      : drift.direction === 'unreadable'
        ? `Can't read which switch-core this runs; this app expects ${drift.expected}`
        : `Runs switch-core ${drift.deployed}; this app expects ${drift.expected}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            className={cn(
              'flex shrink-0 items-center',
              upgrade ? 'text-foreground-warning' : 'text-red-500'
            )}
          >
            {upgrade ? (
              <ArrowUpCircle className="size-3.5" />
            ) : (
              <TriangleAlert className="size-3.5" />
            )}
          </span>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ServerIcon({ server, isScoped }: { server: SwitchServer; isScoped: boolean }) {
  const className = cn('size-4 shrink-0', isScoped && 'text-foreground');
  if (server.managementKind === 'remote') return <Server className={className} />;
  if (server.managed) return <HardDrive className={className} />;
  return <Globe className={className} />;
}

const ServerEntry = observer(function ServerEntry({ serverId }: { serverId: string }) {
  const store = switchServersStore;
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { params } = useParams('server');
  const showRenameServerModal = useShowModal('renameServerModal');
  const showDeleteServerModal = useShowModal('deleteServerModal');
  const showEditServerModal = useShowModal('addServerModal');

  const server = store.servers.find((s) => s.id === serverId);
  if (!server) return null;

  const connected = store.isConnected(serverId);
  const isViewing = isCurrentView(currentView, 'server') && params.serverId === serverId;
  // The active server scopes the whole sidebar (agents/rooms/sessions). Selecting
  // a server makes it active and opens its page. The scoped server stays
  // highlighted regardless of which view is open — navigating to an agent,
  // session, or room must not clear the "this server is selected" affordance.
  const isScoped = store.activeServerId === serverId;

  const availability = serverAvailability(serverId);
  const dormant = availability === 'dormant';
  const needsSignIn = availability === 'signed-out';

  // Drift is reported for a stopped stack too — its volumes still hold the
  // schema the last version migrated to — so this is deliberately not gated on
  // `managedRunning`.
  const drift = !server.managed
    ? null
    : server.managementKind === 'remote' && server.sshHost
      ? remoteServerStore.driftFor(server.sshHost)
      : localServerStore.drift;

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <SidebarMenuButton
            isActive={isScoped}
            onClick={() => {
              void store.setActive(serverId);
              navigate('server', { serverId });
            }}
            className="relative justify-between"
          >
            {isScoped && (
              <span
                aria-hidden
                className="bg-accent absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full"
              />
            )}
            <span className="flex min-w-0 items-center gap-2">
              <ServerIcon server={server} isScoped={isScoped} />
              <span className={cn('truncate', isScoped && 'font-medium text-foreground')}>
                {server.name}
              </span>
              {server.managed && (
                <span className="shrink-0 rounded bg-background-tertiary px-1 py-px text-[10px] font-medium tracking-wide text-foreground-muted uppercase">
                  {server.managementKind === 'remote'
                    ? (server.sshHost ?? 'Remote')
                    : 'This computer'}
                </span>
              )}
              <span
                aria-hidden
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  // Amber reads as "warming up". Neither signed-out nor
                  // unreachable is transitional: both mean this server's data
                  // is unavailable right now, so both are red.
                  dormant ? 'bg-foreground-muted' : connected ? 'bg-green-500' : 'bg-red-500'
                )}
              />
              {drift && <ServerDriftIndicator drift={drift} />}
            </span>
            {needsSignIn && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  navigate('server', { serverId });
                }}
                className="shrink-0 rounded border border-red-500/40 px-1.5 py-0.5 text-xs font-medium text-red-500 hover:bg-red-500/10"
              >
                Sign in
              </span>
            )}
          </SidebarMenuButton>
        }
      />
      <ContextMenuContent>
        <ContextMenuItem
          onClick={() => showRenameServerModal({ serverId, currentName: server.name })}
        >
          <Pencil className="size-4" />
          Rename…
        </ContextMenuItem>
        {!server.managed && (
          <ContextMenuItem
            onClick={() =>
              showEditServerModal({
                serverId,
                initialName: server.name,
                initialGatewayUrl: server.gatewayUrl,
                initialApiUrl: server.apiUrl,
              })
            }
          >
            <ExternalLink className="size-4" />
            Edit connection…
          </ContextMenuItem>
        )}
        <ContextMenuItem
          variant="destructive"
          onClick={() =>
            showDeleteServerModal({
              serverId,
              onSuccess: () => {
                if (isViewing) navigate('home');
              },
            })
          }
        >
          <Trash2 className="size-4" />
          Delete server…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});
