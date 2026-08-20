import { DoorOpen, ExternalLink } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { TitlebarBreadcrumb } from '@renderer/lib/components/titlebar/titlebar-breadcrumb';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { RoomConfigurationPanel } from './room-configuration-panel';
import { openRoomChannel } from './room-links';
import { type RoomTab, roomTabStore } from './room-tab-store';

/**
 * Opens the room's channel in the messaging app it is bridged to. The embedded
 * view is a convenience, not a replacement — threads, search and notifications
 * live in the real client, so there is always a way out to it.
 *
 * Rendered only when the gateway supplied a deeplink; an unbridged room has no
 * messaging app to open, and a button that quietly does nothing is worse than
 * no button.
 */
const OpenInMessagingApp = observer(function OpenInMessagingApp({ roomId }: { roomId: string }) {
  const bridgeType = switchRoomsStore.roomBridgeTypeById(roomId);
  if (!switchRoomsStore.roomChannelUrl(roomId)) return null;

  const platform = bridgePlatformLabel(bridgeType);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="size-7 p-0"
            aria-label={`Open in ${platform}`}
            onClick={() => openRoomChannel(roomId)}
          >
            {hasBridgeIcon(bridgeType) ? (
              <BridgeIcon bridgeType={bridgeType} size={16} className="size-4" />
            ) : (
              <ExternalLink className="size-4" />
            )}
          </Button>
        }
      />
      <TooltipContent side="bottom">Open in {platform}</TooltipContent>
    </Tooltip>
  );
});

const TABS = [
  { value: 'chat', label: 'Chat' },
  { value: 'configuration', label: 'Configuration' },
] as const satisfies readonly { value: RoomTab; label: string }[];

/**
 * A room opened on its own is its own root: it belongs to a server and to every
 * agent in it, and picking one of those to stand in front of it would be a
 * claim about how you got here rather than about where you are.
 *
 * The two sides of a room sit next to its name rather than in a sidebar or a
 * menu: there are only two, and which one you are on is the first thing you
 * need to know about the page under it.
 */
const RoomTitlebar = observer(function RoomTitlebar() {
  const { params } = useParams('room');
  const name = switchRoomsStore.roomNameById(params.roomId);
  const bridgeType = switchRoomsStore.roomBridgeTypeById(params.roomId);

  return (
    <Titlebar
      leftSlot={
        <div className="flex min-w-0 items-center gap-3">
          <TitlebarBreadcrumb
            crumbs={[
              {
                key: 'room',
                icon: hasBridgeIcon(bridgeType) ? (
                  <BridgeIcon bridgeType={bridgeType} size={14} className="shrink-0" />
                ) : (
                  <DoorOpen className="size-3.5 shrink-0" />
                ),
                label: name ?? 'Room',
              },
            ]}
          />
          <SegmentedControl
            value={roomTabStore.tabFor(params.roomId)}
            onChange={(tab) => roomTabStore.setTab(params.roomId, tab)}
            options={TABS}
            ariaLabel="Room view"
          />
        </div>
      }
      rightSlot={
        <div className="mr-2 flex items-center gap-1">
          <OpenInMessagingApp roomId={params.roomId} />
        </div>
      }
    />
  );
});

/** Settings when the room is showing them; otherwise nothing, and the
 * conversation drawn by `RoomEmbedLayer` above shows through. */
const RoomMainPanel = observer(function RoomMainPanel() {
  const { params } = useParams('room');
  if (roomTabStore.tabFor(params.roomId) !== 'configuration') return null;
  return <RoomConfigurationPanel roomId={params.roomId} />;
});

export const roomView = {
  WrapView: ({ children }: { children: React.ReactNode; roomId: string }) => <>{children}</>,
  TitlebarSlot: RoomTitlebar,
  // The conversation itself is drawn by RoomEmbedLayer, which is mounted above
  // the view switch so its <webview> survives navigating away and back. This
  // panel only ever holds the room's other side.
  MainPanel: RoomMainPanel,
  canActivate: (params: unknown): GuardResult => {
    const roomId =
      typeof params === 'object' && params !== null
        ? (params as { roomId?: unknown }).roomId
        : undefined;
    if (typeof roomId !== 'string') {
      return { ok: false, redirect: 'home' };
    }
    return { ok: true };
  },
} satisfies ViewDefinition<{ roomId: string }>;
