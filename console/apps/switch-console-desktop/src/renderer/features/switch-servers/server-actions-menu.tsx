import { ExternalLink, Pencil, Settings2, Trash2, Unplug } from 'lucide-react';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { navigateHome } from './home-target';

/**
 * The window's server's own actions, as a submenu of the sidebar switcher:
 * rename it, change how it is reached, and let go of it.
 */
export function ServerActionsSubmenu({
  server,
  className,
}: {
  server: SwitchServer;
  className: string;
}) {
  const showEditServerModal = useShowModal('addServerModal');
  const showRenameServerModal = useShowModal('renameServerModal');
  const showDeleteServerModal = useShowModal('deleteServerModal');
  const serverId = server.id;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={className}>
        <Settings2 className="size-4" />
        <span className="min-w-0 truncate">Manage {server.name}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-52">
        <DropdownMenuItem
          onClick={() => showRenameServerModal({ serverId, currentName: server.name })}
        >
          <Pencil className="size-4" />
          Rename…
        </DropdownMenuItem>
        {!server.managed && (
          <DropdownMenuItem
            onClick={() =>
              showEditServerModal({ serverId, initialName: server.name, initialUrl: server.url })
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
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
