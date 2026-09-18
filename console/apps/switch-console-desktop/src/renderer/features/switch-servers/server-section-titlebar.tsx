import type { LucideIcon } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { TitlebarBreadcrumb } from '@renderer/lib/components/titlebar/titlebar-breadcrumb';
import { ServerAvatar, ServerStatusPill } from './server-presentation';
import { switchServersStore } from './switch-servers-store';

/**
 * The titlebar shared by every page of a server's workspace: which server, then
 * which of its sections, then how the connection is doing.
 *
 * One component rather than one per page, because the breadcrumb is the only
 * thing telling you which workspace you are in — three copies of it are three
 * chances for the pages to disagree about that.
 */
export const ServerSectionTitlebar = observer(function ServerSectionTitlebar({
  serverId,
  icon: SectionIcon,
  label,
  item,
  onSectionClick,
}: {
  serverId: string;
  icon: LucideIcon;
  label: string;
  /** A third breadcrumb for a page inside the section, such as one template's page. */
  item?: { label: string; icon?: React.ReactNode };
  /** Navigates back to the section's list. Used when `item` is shown, so the section crumb is clickable. */
  onSectionClick?: () => void;
}) {
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  return (
    <Titlebar
      leftSlot={
        <TitlebarBreadcrumb
          crumbs={[
            {
              key: 'server',
              icon: server && <ServerAvatar server={server} size="sm" />,
              label: server?.name ?? 'Server',
              maxWidthClassName: 'max-w-40',
            },
            {
              key: 'section',
              icon: <SectionIcon className="size-3.5 shrink-0" />,
              label,
              ...(item && onSectionClick ? { onClick: onSectionClick } : {}),
            },
            ...(item
              ? [{ key: 'item', icon: item.icon, label: item.label, maxWidthClassName: 'max-w-64' }]
              : []),
          ]}
        />
      }
      rightSlot={
        server && (
          <div className="mr-1 flex items-center gap-1.5">
            <ServerStatusPill server={server} />
          </div>
        )
      }
    />
  );
});
