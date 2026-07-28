import { ExternalLink, Loader2, MessagesSquare, RefreshCw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState } from 'react';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import type { RoomEmbed } from '@shared/core/switch-rooms/room-embed';

type EmbedState =
  | { phase: 'resolving' }
  | { phase: 'ready'; embed: RoomEmbed }
  | { phase: 'error'; message: string };

/** Centred message with an optional action — every non-inline state uses it. */
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

export const RoomMainPanel = observer(function RoomMainPanel() {
  const { params } = useParams('room');
  const roomId = params.roomId;
  const [state, setState] = useState<EmbedState>({ phase: 'resolving' });

  const resolve = useCallback(async () => {
    setState({ phase: 'resolving' });
    const serverId = switchRoomsStore.roomServerId(roomId);
    if (!serverId) {
      setState({
        phase: 'error',
        message: 'This room’s server is still loading. Try again in a moment.',
      });
      return;
    }
    try {
      const embed = await rpc.switchRooms.resolveRoomEmbed({
        serverId,
        bridgeType: switchRoomsStore.roomBridgeTypeById(roomId),
        externalChannelUrl: switchRoomsStore.roomChannelUrl(roomId),
      });
      setState({ phase: 'ready', embed });
    } catch (cause) {
      setState({
        phase: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, [roomId]);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  if (state.phase === 'resolving') {
    return (
      <RoomNotice
        icon={<Loader2 className="size-5 animate-spin" />}
        title="Opening conversation…"
      />
    );
  }

  if (state.phase === 'error') {
    return (
      <RoomNotice
        icon={<MessagesSquare className="size-6" />}
        title="Couldn’t open this conversation"
        detail={state.message}
        action={
          <Button variant="outline" size="sm" onClick={() => void resolve()}>
            <RefreshCw className="size-3" />
            Retry
          </Button>
        }
      />
    );
  }

  const { embed } = state;

  if (embed.kind === 'unavailable') {
    return <RoomNotice icon={<MessagesSquare className="size-6" />} title={embed.reason} />;
  }

  if (embed.kind === 'external') {
    return (
      <RoomNotice
        icon={<MessagesSquare className="size-6" />}
        title={`This room lives in ${embed.platform}`}
        detail="Conversations on external platforms open in their own app."
        action={
          <Button variant="outline" size="sm" onClick={() => void rpc.app.openExternal(embed.url)}>
            <ExternalLink className="size-3" />
            Open in {embed.platform}
          </Button>
        }
      />
    );
  }

  return (
    <webview
      // Remounting on url/partition change is intentional: <webview> does not
      // reliably re-navigate when its src attribute is swapped in place.
      key={`${embed.partition}:${embed.url}`}
      src={embed.url}
      partition={embed.partition}
      className="h-full w-full"
    />
  );
});
