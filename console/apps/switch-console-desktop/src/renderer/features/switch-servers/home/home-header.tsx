import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, MoreHorizontal, Pencil, RefreshCw, Trash2, Unplug } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { workspaceTitle } from '@renderer/features/workspaces/workspace-title';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { cn } from '@renderer/utils/utils';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { navigateHome } from '../home-target';
import { serverIcon } from '../server-icon';
import { ServerStatusPill, serverPlacementLabel } from '../server-presentation';
import { isSwitchCloudServer } from '../switch-cloud-store';
import { switchRoomsStore } from '../switch-rooms-store';
import { switchServersStore } from '../switch-servers-store';
import { myIdentitiesQueryKey } from '../use-my-identities';

/** How long Refresh keeps spinning at minimum. Long enough to be seen as a
 * response to the click, short enough not to feel like waiting. */
const MIN_REFRESH_FEEDBACK_MS = 600;

/**
 * Home's one header row: which server, which workspace on it, how the
 * connection is doing, and the server's own actions. It stands in for both
 * the titlebar breadcrumb the other workspace pages keep and a page title.
 */
export const HomeHeader = observer(function HomeHeader({
  server,
  canRefresh,
}: {
  server: SwitchServer;
  /** False while there is nothing to re-read, such as a server that is not running. */
  canRefresh: boolean;
}) {
  const serverId = server.id;
  const queryClient = useQueryClient();
  const showEditServerModal = useShowModal('addServerModal');
  const showRenameServerModal = useShowModal('renameServerModal');
  const showDeleteServerModal = useShowModal('deleteServerModal');
  const [refreshingPage, setRefreshingPage] = useState(false);

  /**
   * Everything the page goes by, re-read: the connection, and the lists the
   * switch-buddy suggestions are picked from.
   *
   * Held on screen for a moment even when the reads come back instantly. A
   * spinner that appears and vanishes inside one frame reads as a button that
   * did nothing, which is the opposite of what it did.
   */
  const refreshEverything = async (): Promise<void> => {
    setRefreshingPage(true);
    // These caches are keyed by workspace, so a server id would invalidate nothing.
    const workspaceId = workspacesStore.idOnServerInScope(serverId);
    try {
      await Promise.all([
        switchServersStore.refreshServer(serverId),
        queryClient.invalidateQueries({ queryKey: ['remote-bridges', workspaceId] }),
        queryClient.invalidateQueries({ queryKey: myIdentitiesQueryKey(workspaceId) }),
        queryClient.invalidateQueries({ queryKey: ['owns-owner-addressed-agent', workspaceId] }),
        switchRoomsStore.refreshRoomState(),
        agentsStore.load(),
        new Promise((resolve) => setTimeout(resolve, MIN_REFRESH_FEEDBACK_MS)),
      ]);
    } finally {
      setRefreshingPage(false);
    }
  };

  // A background status poll spins the button too: it is the same reading the
  // button asks for, so the page should not look idle while one is in flight.
  const busy = refreshingPage || switchServersStore.refreshing.has(serverId);
  const PlacementIcon = serverIcon(server);
  const title = workspaceTitle(server);

  return (
    <div className="flex min-w-0 items-center gap-2 pl-4 text-sm">
      {/* Before sign-in the title is named after the server; saying it twice says nothing. */}
      {title !== server.name && (
        <>
          <span className="max-w-48 truncate text-foreground-muted">{server.name}</span>
          <span aria-hidden className="text-foreground-muted">
            /
          </span>
        </>
      )}
      <span className="flex min-w-0 items-center gap-1.5">
        <PlacementIcon
          aria-label={
            serverPlacementLabel(server) ??
            (isSwitchCloudServer(server) ? 'Switch Cloud' : 'Reached over the network')
          }
          className="size-3.5 shrink-0"
        />
        <span className="truncate font-medium text-foreground">{title}</span>
      </span>
      <ServerStatusPill server={server} />
      <div className="ml-2 flex shrink-0 items-center gap-0.5">
        {canRefresh && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh"
            title="Refresh"
            disabled={busy}
            onClick={() => void refreshEverything()}
          >
            <RefreshCw className={cn('size-4', busy && 'animate-spin')} />
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label="Server actions">
                <MoreHorizontal className="size-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="start">
            <DropdownMenuItem
              onClick={() => showRenameServerModal({ serverId, currentName: server.name })}
            >
              <Pencil className="size-4" />
              Rename…
            </DropdownMenuItem>
            {!server.managed && (
              <DropdownMenuItem
                onClick={() =>
                  showEditServerModal({
                    serverId,
                    initialName: server.name,
                    initialUrl: server.url,
                  })
                }
              >
                <ExternalLink className="size-4" />
                Edit connection…
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {/* Only a server Switch Console runs is one it can delete; for
                anyone else's, all we can do is let go of it. A remote one
                offers both, since its host is shared. All stay red: either
                way every agent pointed at this server loses it. */}
            <DropdownMenuItem
              variant="destructive"
              onClick={() => showDeleteServerModal({ serverId, onSuccess: navigateHome })}
            >
              {server.managed && server.managementKind !== 'remote' ? (
                <Trash2 className="size-4" />
              ) : (
                <Unplug className="size-4" />
              )}
              {!server.managed
                ? 'Disconnect from server…'
                : server.managementKind === 'remote'
                  ? 'Disconnect or delete…'
                  : 'Delete server…'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
});
