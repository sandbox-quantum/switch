import { ExternalLink, Loader2, MessagesSquare, RefreshCw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { useTheme } from '@renderer/lib/hooks/useTheme';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/utils/utils';
import type { RoomEmbed } from '@shared/core/switch-rooms/room-embed';
import { currentMattermostTheme } from './theme-tokens';

/**
 * How many rooms keep a live `<webview>` once visited. Each one is a real
 * renderer process, so this trades memory for instant switching; beyond a
 * handful the cost stops being worth it and the oldest is dropped.
 */
const MAX_LIVE_EMBEDS = 4;

type EmbedState =
  | { phase: 'resolving' }
  | { phase: 'ready'; embed: RoomEmbed }
  | { phase: 'error'; message: string };

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

/**
 * Persistent host for room conversations.
 *
 * This lives above the view switch rather than inside the room view's
 * MainPanel, because a `<webview>` reloads from scratch whenever it is
 * unmounted OR re-parented — so navigating to a session and back used to
 * re-download and re-render the whole Mattermost client. Keeping the element
 * mounted and toggling visibility is the only way to make that instant.
 *
 * Rooms visited earlier stay mounted (bounded by MAX_LIVE_EMBEDS) so switching
 * between two rooms is instant in both directions.
 */
export const RoomEmbedLayer = observer(function RoomEmbedLayer() {
  const { effectiveTheme } = useTheme();
  const isRoomView = appState.navigation.currentViewId === 'room';
  const activeRoomId =
    (appState.navigation.viewParamsStore.room as { roomId?: string } | undefined)?.roomId ?? null;

  const [states, setStates] = useState<Map<string, EmbedState>>(new Map());
  // Visit order, oldest first — drives eviction.
  const orderRef = useRef<string[]>([]);
  // Which rooms have been resolved (or are in flight). Held in a ref so the
  // effect below can consult it without depending on `states`, which it also
  // writes — that dependency would re-run it on every resolution.
  const startedRef = useRef(new Set<string>());

  const resolve = useCallback(
    async (roomId: string) => {
      startedRef.current.add(roomId);
      setStates((prev) => new Map(prev).set(roomId, { phase: 'resolving' }));

      const serverId = switchRoomsStore.roomServerId(roomId);
      if (!serverId) {
        setStates((prev) =>
          new Map(prev).set(roomId, {
            phase: 'error',
            message: 'This room’s server is still loading. Try again in a moment.',
          })
        );
        return;
      }

      try {
        const embed = await rpc.switchRooms.resolveRoomEmbed({
          serverId,
          bridgeType: switchRoomsStore.roomBridgeTypeById(roomId),
          externalChannelUrl: switchRoomsStore.roomChannelUrl(roomId),
          theme: currentMattermostTheme(effectiveTheme),
        });
        setStates((prev) => new Map(prev).set(roomId, { phase: 'ready', embed }));
      } catch (cause) {
        setStates((prev) =>
          new Map(prev).set(roomId, {
            phase: 'error',
            message: cause instanceof Error ? cause.message : String(cause),
          })
        );
      }
    },
    [effectiveTheme]
  );

  // Resolve a room the first time it is opened, and evict the oldest beyond the
  // cap. Rooms already resolved are left alone — that is the whole point.
  useEffect(() => {
    if (!activeRoomId) return;

    orderRef.current = [...orderRef.current.filter((id) => id !== activeRoomId), activeRoomId];
    const evicted = orderRef.current.slice(0, -MAX_LIVE_EMBEDS);
    orderRef.current = orderRef.current.slice(-MAX_LIVE_EMBEDS);

    if (evicted.length) {
      for (const id of evicted) startedRef.current.delete(id);
      setStates((prev) => {
        const next = new Map(prev);
        for (const id of evicted) next.delete(id);
        return next;
      });
    }

    if (!startedRef.current.has(activeRoomId)) void resolve(activeRoomId);
  }, [activeRoomId, resolve]);

  // A theme switch has to be pushed to Mattermost, so re-resolve what is on
  // screen. Rooms in the background pick it up when next opened.
  const themeRef = useRef(effectiveTheme);
  useEffect(() => {
    if (themeRef.current === effectiveTheme) return;
    themeRef.current = effectiveTheme;
    if (activeRoomId) void resolve(activeRoomId);
  }, [effectiveTheme, activeRoomId, resolve]);

  // Never unmount, even off a room view: returning null here would destroy
  // every live <webview> and reload Mattermost on the way back, which is the
  // exact cost this layer exists to avoid. Hide the whole layer instead —
  // display:none keeps the guests running and takes the layer out of both
  // layout and hit-testing, so the view underneath behaves normally.
  const visible = isRoomView && activeRoomId !== null;
  const active = activeRoomId ? states.get(activeRoomId) : undefined;

  return (
    <div
      className={cn(
        'absolute inset-x-0 top-10 bottom-0 overflow-hidden rounded-b-[10px] bg-background',
        visible ? 'block' : 'hidden'
      )}
    >
      {visible && (active?.phase === 'resolving' || active === undefined) ? (
        <RoomNotice
          icon={<Loader2 className="size-5 animate-spin" />}
          title="Opening conversation…"
        />
      ) : null}

      {visible && active?.phase === 'error' ? (
        <RoomNotice
          icon={<MessagesSquare className="size-6" />}
          title="Couldn’t open this conversation"
          detail={active.message}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => activeRoomId && void resolve(activeRoomId)}
            >
              <RefreshCw className="size-3" />
              Retry
            </Button>
          }
        />
      ) : null}

      {visible && active?.phase === 'ready' && active.embed.kind === 'unavailable' ? (
        <RoomNotice icon={<MessagesSquare className="size-6" />} title={active.embed.reason} />
      ) : null}

      {visible && active?.phase === 'ready' && active.embed.kind === 'external' ? (
        <RoomNotice
          icon={<MessagesSquare className="size-6" />}
          title={`This room lives in ${capitalise(active.embed.platform)}`}
          detail="Conversations on external platforms open in their own app."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const embed = active.embed;
                if (embed.kind === 'external') void rpc.app.openExternal(embed.url);
              }}
            >
              <ExternalLink className="size-3" />
              Open in {capitalise(active.embed.platform)}
            </Button>
          }
        />
      ) : null}

      {/* Every inline room stays mounted; only the active one is visible.
          Unmounting or moving these would reload Mattermost. */}
      {[...states.entries()].map(([roomId, state]) =>
        state.phase === 'ready' && state.embed.kind === 'inline' ? (
          <webview
            key={`${state.embed.partition}:${state.embed.url}`}
            src={state.embed.url}
            partition={state.embed.partition}
            className={cn('h-full w-full', roomId === activeRoomId ? 'flex' : 'hidden')}
          />
        ) : null
      )}
    </div>
  );
});

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
