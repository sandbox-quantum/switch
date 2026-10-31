import { ExternalLink, Loader2, MessagesSquare, RefreshCw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useLayoutEffect, useRef, useState } from 'react';
import { opensAsConsoleChat } from '@renderer/features/chats/console-chat-redirect';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { appState } from '@renderer/lib/stores/app-state';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/utils/utils';
import { resolveRoomEmbed } from '@shared/core/switch-rooms/room-embed';
import { roomEmbedSlotStore } from './room-embed-slot';
import { openRoomChannel } from './room-links';
import { roomTabStore } from './room-tab-store';

function RoomNotice({
  icon,
  title,
  detail,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-foreground-passive">{icon}</div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {detail && <p className="max-w-md text-xs text-foreground-muted">{detail}</p>}
      {action}
    </div>
  );
}

type Box = { top: number; left: number; width: number; height: number };

/**
 * Where `target` sits inside the layer's parent, which the layer is positioned
 * against, followed as either is resized; null while there is no target.
 * The parent rather than `offsetParent`, which is null while the layer is hidden.
 */
function useBoxWithin(
  target: HTMLElement | null,
  layer: React.RefObject<HTMLDivElement | null>
): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useLayoutEffect(() => {
    const container = layer.current?.parentElement ?? null;
    if (!target || !container) {
      setBox(null);
      return;
    }
    const measure = () => {
      const inner = target.getBoundingClientRect();
      const outer = container.getBoundingClientRect();
      setBox({
        top: inner.top - outer.top,
        left: inner.left - outer.left,
        width: inner.width,
        height: inner.height,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    observer.observe(container);
    return () => observer.disconnect();
  }, [target, layer]);
  return box;
}

/**
 * Host for a room's conversation when it is not a Console chat: where it lives
 * instead, laid over the room view's main panel under its title bar, or — when
 * a page shows a room inside itself, as an agent's page does — over the box
 * that page claimed in `roomEmbedSlotStore`.
 */
export const RoomEmbedLayer = observer(function RoomEmbedLayer() {
  const isRoomView = appState.navigation.currentViewId === 'room';
  const navigatedRoomId =
    (appState.navigation.viewParamsStore.room as { roomId?: string } | undefined)?.roomId ?? null;
  const slot = roomEmbedSlotStore.slot;
  const activeRoomId = slot?.roomId ?? navigatedRoomId;
  // A Console chat has no channel to embed; the room view draws its conversation.
  const consoleChat = activeRoomId !== null && opensAsConsoleChat(activeRoomId);
  const layerRef = useRef<HTMLDivElement>(null);
  const slotBox = useBoxWithin(slot?.element ?? null, layerRef);

  const visible =
    (slot ? slotBox !== null : isRoomView) &&
    activeRoomId !== null &&
    !consoleChat &&
    roomTabStore.tabFor(activeRoomId, slot ? 'configuration' : 'chat') === 'chat';
  // Until the room list has loaded, the room's bridge is not known yet.
  const loading = activeRoomId !== null && switchRoomsStore.roomServerId(activeRoomId) === null;
  const embed =
    activeRoomId === null
      ? null
      : resolveRoomEmbed(
          switchRoomsStore.roomBridgeTypeById(activeRoomId),
          switchRoomsStore.roomChannelUrl(activeRoomId)
        );

  return (
    <div
      ref={layerRef}
      style={slot && slotBox ? slotBox : undefined}
      className={cn(
        'absolute overflow-hidden bg-background',
        slot ? 'rounded-br-[10px]' : 'inset-x-0 top-10 bottom-0 rounded-b-[10px]',
        visible ? 'block' : 'hidden'
      )}
    >
      {visible && loading ? (
        <RoomNotice
          icon={<Loader2 className="size-5 animate-spin" />}
          title="Opening conversation…"
        />
      ) : null}

      {visible && !loading && embed?.kind === 'unavailable' ? (
        <RoomNotice
          icon={<MessagesSquare className="size-6" />}
          title={embed.reason}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void switchRoomsStore.loadRoomNames()}
            >
              <RefreshCw className="size-3" />
              Retry
            </Button>
          }
        />
      ) : null}

      {visible && !loading && embed?.kind === 'unlinked' ? (
        <RoomNotice
          icon={<MessagesSquare className="size-6" />}
          title={`This room is bridged to ${bridgePlatformLabel(embed.platform)}, which cannot be shown inside Switch Console.`}
        />
      ) : null}

      {visible && !loading && embed?.kind === 'external' ? (
        <RoomNotice
          icon={<MessagesSquare className="size-6" />}
          title={`This room lives in ${bridgePlatformLabel(embed.platform)}`}
          detail="Conversations on external platforms open in their own app, or in your browser when it is not installed."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => activeRoomId && openRoomChannel(activeRoomId)}
            >
              <ExternalLink className="size-3" />
              Open in {bridgePlatformLabel(embed.platform)}
            </Button>
          }
        />
      ) : null}
    </div>
  );
});
