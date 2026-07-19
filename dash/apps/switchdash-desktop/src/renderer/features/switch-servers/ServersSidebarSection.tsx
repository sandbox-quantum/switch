import { ChevronDown, ChevronRight, Plus, Server } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import {
  isCurrentView,
  useNavigate,
  useParams,
  useWorkspaceSlots,
} from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { buttonVariants } from '@renderer/lib/ui/button';
import { MicroLabel } from '@renderer/lib/ui/label';
import { Spinner } from '@renderer/lib/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import { SidebarMenu, SidebarMenuButton } from '../sidebar/sidebar-primitives';
import { localServerStore } from './local-server-store';
import { switchServersStore } from './switch-servers-store';

export const ServersSidebarSection = observer(function ServersSidebarSection() {
  const store = switchServersStore;
  const showAddServerModal = useShowModal('addServerModal');

  useEffect(() => {
    void store.init();
    void localServerStore.init();
    const onFocus = () => void store.refreshAllStatuses();
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      localServerStore.dispose();
    };
  }, [store]);

  // Nothing registered yet — keep the sidebar uncluttered, but still expose a
  // way to add the first server.
  const empty = store.servers.length === 0;
  // Offer to start a local server whenever there isn't one already, even if the
  // user has remote servers registered.
  const hasManagedServer = store.servers.some((s) => s.managed);

  return (
    <div className="flex flex-col">
      <div className="flex h-[40px] items-center justify-between pr-2.5 pl-2">
        <button
          type="button"
          onClick={() => store.toggleServersExpanded()}
          className="flex items-center gap-1 rounded-md px-1 py-0.5 text-foreground-tertiary-passive hover:text-foreground-tertiary"
          aria-label={store.serversExpanded ? 'Collapse servers' : 'Expand servers'}
        >
          {store.serversExpanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          <MicroLabel className="text-foreground-tertiary-passive">Servers</MicroLabel>
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
          {!hasManagedServer && localServerStore.phase === 'stopped' && (
            <button
              type="button"
              onClick={() => showAddServerModal({ mode: 'local' })}
              className="w-full px-3 py-1.5 text-left text-xs text-foreground-tertiary hover:text-foreground"
            >
              Start a local server…
            </button>
          )}
          {empty && (
            <button
              type="button"
              onClick={() => showAddServerModal({})}
              className="w-full px-3 py-1.5 text-left text-xs text-foreground-tertiary-passive hover:text-foreground-tertiary"
            >
              Add a remote server…
            </button>
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
        <Server className="size-4 shrink-0" />
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

const ServerEntry = observer(function ServerEntry({ serverId }: { serverId: string }) {
  const store = switchServersStore;
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { params } = useParams('server');

  const server = store.servers.find((s) => s.id === serverId);
  if (!server) return null;

  const connected = store.isConnected(serverId);
  const isViewing = isCurrentView(currentView, 'server') && params.serverId === serverId;
  // The active server scopes the whole sidebar (agents/rooms/sessions). Selecting
  // a server makes it active and opens its page.
  const isScoped = store.activeServerId === serverId;

  return (
    <SidebarMenuButton
      isActive={isViewing}
      onClick={() => {
        void store.setActive(serverId);
        navigate('server', { serverId });
      }}
      className="justify-between"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Server className={cn('size-4 shrink-0', isScoped && 'text-foreground')} />
        <span className={cn('truncate', isScoped && 'font-medium text-foreground')}>
          {server.name}
        </span>
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            connected ? 'bg-green-500' : 'bg-amber-500'
          )}
        />
      </span>
      {!connected && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            navigate('server', { serverId });
          }}
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-foreground-muted hover:bg-background-tertiary-2 hover:text-foreground"
        >
          Sign in
        </span>
      )}
    </SidebarMenuButton>
  );
});
