import { ChatPanel } from '@switch-console/chat-ui/components/chat-panel';
import { DoorOpen, ExternalLink } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useLayoutEffect, useRef } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import {
  ConsoleChatRedirect,
  opensAsConsoleChat,
} from '@renderer/features/chats/console-chat-redirect';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import { RoomConfigurationPanel } from './room-configuration-panel';
import { roomEmbedSlotStore } from './room-embed-slot';
import { openRoomChannel } from './room-links';
import { RoomResourcesPanel } from './room-resources-panel';
import { RoomSidePanel } from './room-side-panel';
import { embeddedRoomTab, type RoomTab, roomTabStore } from './room-tab-store';

/**
 * Opens the room's channel in the messaging app it is bridged to. The embedded
 * view is a convenience, not a replacement — threads, search and notifications
 * live in the real client, so there is always a way out to it.
 *
 * Rendered only when the gateway supplied a deeplink; an unbridged room has no
 * messaging app to open, and a button that quietly does nothing is worse than
 * no button.
 */
export const OpenInMessagingApp = observer(function OpenInMessagingApp({
  roomId,
}: {
  roomId: string;
}) {
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
  { value: 'resources', label: 'Resources' },
  { value: 'configuration', label: 'Configuration' },
] as const satisfies readonly { value: RoomTab; label: string }[];

/**
 * A room's tabs — its conversation, what its agents are given, and its
 * settings — to pick between; `fallback` is the tab showing until one is
 * picked.
 */
export const RoomTabs = observer(function RoomTabs({
  roomId,
  fallback,
}: {
  roomId: string;
  fallback: RoomTab;
}) {
  return (
    <SegmentedControl
      value={roomTabStore.tabFor(roomId, fallback)}
      onChange={(tab) => roomTabStore.setTab(roomId, tab)}
      options={TABS}
      ariaLabel="Room view"
    />
  );
});

/**
 * A room opened on its own is its own root: it belongs to a server and to every
 * agent in it, and picking one of those to stand in front of it would be a
 * claim about how you got here rather than about where you are.
 *
 * Beside the name: where the room lives (its messaging app, or a group chat
 * here) and what it is for; on the right, its tabs.
 */
const RoomTitlebar = observer(function RoomTitlebar() {
  const { params } = useParams('room');
  const roomId = params.roomId;
  const summary = switchRoomsStore.roomSummaryById(roomId);
  const name = switchRoomsStore.roomNameById(roomId) ?? chatsStore.chat(roomId)?.name ?? null;
  const bridgeType = switchRoomsStore.roomBridgeTypeById(roomId);
  const where = summary?.bridgeDisplayName ?? (opensAsConsoleChat(roomId) ? 'Group chat' : null);
  const description = summary?.description.trim() || null;

  return (
    <Titlebar
      // The same frame as a room opened on an agent's page: inset from the
      // edge, a rule under it, the tabs at the right so they stay put.
      // A description is a second line, so the bar grows to keep the same
      // space above and below as a one-line bar has.
      className={cn('border-b border-border pr-[7px] pl-4', description && 'h-[60px]')}
      leftClassName="min-w-0 flex-1"
      leftSlot={
        // The description goes under the name, never beside it, so however
        // long it is it cannot push the tabs off the bar.
        <div className="flex min-w-0 flex-col justify-center">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium">
              {hasBridgeIcon(bridgeType) ? (
                <BridgeIcon bridgeType={bridgeType} size={16} />
              ) : (
                <DoorOpen className="size-4 shrink-0" />
              )}
              <span className="truncate">{name ?? 'Room'}</span>
            </span>
            {where && (
              <span className="shrink-0 rounded-full bg-background-tertiary px-2 py-0.5 text-[11px] text-foreground-muted">
                {where}
              </span>
            )}
          </div>
          {description && (
            <span
              className="min-w-0 truncate text-xs leading-4 text-foreground-muted"
              title={description}
            >
              {description}
            </span>
          )}
        </div>
      }
      rightSlot={
        <div className="flex shrink-0 items-center gap-1.5">
          <RoomTabs roomId={roomId} fallback="chat" />
          <OpenInMessagingApp roomId={roomId} />
        </div>
      }
    />
  );
});

/** A Console chat's conversation, drawn here rather than by `RoomEmbedLayer`. */
const ConsoleChat = observer(function ConsoleChat({ roomId }: { roomId: string }) {
  const serverId = chatsStore.serverId;
  if (!serverId || !opensAsConsoleChat(roomId)) return null;
  return <ChatPanel key={`${serverId}:${roomId}`} serverId={serverId} roomId={roomId} />;
});

/**
 * The room's page: who is in it down the side, the same on every platform,
 * and beside that the tab picked in the title bar — its conversation, its
 * resources or its settings.
 */
const RoomMainPanel = observer(function RoomMainPanel(): React.JSX.Element {
  const { params } = useParams('room');
  const roomId = params.roomId;
  const tab = roomTabStore.tabFor(roomId, 'chat');
  return (
    <>
      <ConsoleChatRedirect roomId={roomId} />
      <div className="flex h-full min-h-0">
        <RoomSidePanel roomId={roomId} />
        {tab === 'chat' ? (
          <RoomConversation roomId={roomId} />
        ) : (
          <div className="min-w-0 flex-1">
            {tab === 'resources' ? (
              <RoomResourcesPanel roomId={roomId} />
            ) : (
              <RoomConfigurationPanel roomId={roomId} />
            )}
          </div>
        )}
      </div>
    </>
  );
});

/**
 * The room's conversation beside its side panel: a Console chat drawn here, or
 * a box that `RoomEmbedLayer` lays the messaging app's conversation over —
 * the app itself where it can be drawn inline, otherwise its way out to it.
 */
const RoomConversation = observer(function RoomConversation({ roomId }: { roomId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const consoleChat = opensAsConsoleChat(roomId);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || consoleChat) return;
    roomEmbedSlotStore.claim({ roomId, element, fallback: 'chat' });
    return () => roomEmbedSlotStore.release(element);
  }, [roomId, consoleChat]);
  return (
    <div ref={ref} data-testid="room-conversation" className="flex min-w-0 flex-1 flex-col">
      {consoleChat && <ConsoleChat roomId={roomId} />}
    </div>
  );
});

/** The side a room shown inside another page opens on, until one is picked. */
export function embeddedRoomFallbackTab(roomId: string): RoomTab {
  return embeddedRoomTab(switchRoomsStore.roomBridgeTypeById(roomId), opensAsConsoleChat(roomId));
}

/**
 * A room shown inside another page, as an agent's page shows one beside its
 * column: the same conversation as the room view, which `RoomEmbedLayer` lays
 * over this box, or the same settings — the conversation first when its
 * platform can be drawn here, the settings first when it cannot. Fills its
 * parent; the page puts the room's `RoomTabs` and `OpenInMessagingApp` in its
 * own title bar.
 */
export const EmbeddedRoom = observer(function EmbeddedRoom({ roomId }: { roomId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    roomEmbedSlotStore.claim({ roomId, element });
    return () => roomEmbedSlotStore.release(element);
  }, [roomId]);
  return (
    <div ref={ref} data-testid="embedded-room" className="min-h-0 flex-1">
      {embeddedTabContent(roomId, roomTabStore.tabFor(roomId, embeddedRoomFallbackTab(roomId)))}
    </div>
  );
});

function embeddedTabContent(roomId: string, tab: RoomTab): React.ReactNode {
  if (tab === 'resources') return <RoomResourcesPanel roomId={roomId} />;
  if (tab === 'configuration') return <RoomConfigurationPanel roomId={roomId} />;
  return <ConsoleChat roomId={roomId} />;
}

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
