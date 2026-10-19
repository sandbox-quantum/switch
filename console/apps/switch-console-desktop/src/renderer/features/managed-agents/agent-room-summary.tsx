import { ExternalLink, Loader2, Settings } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { openRoomView } from '@renderer/features/sidebar/sidebar-room-grouping';
import {
  ParticipantList,
  useRoomDetail,
} from '@renderer/features/switch-rooms/room-configuration-panel';
import { membershipSummary } from '@renderer/features/switch-rooms/room-labels';
import { openRoomChannel } from '@renderer/features/switch-rooms/room-links';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { Button } from '@renderer/lib/ui/button';

/**
 * A room the agent is in, summarised on the agent's page: what it is, where it
 * is bridged, and who is in it. What the room list already knows shows at
 * once; who is in it comes with the room's own read.
 */
export const AgentRoomSummary = observer(function AgentRoomSummary({
  roomId,
  fallbackName,
}: {
  roomId: string;
  fallbackName: string;
}) {
  const { workspaceId, query } = useRoomDetail(roomId);
  const summary = query.data ?? switchRoomsStore.roomSummaryById(roomId);
  const name = switchRoomsStore.roomNameById(roomId) ?? summary?.name ?? fallbackName;
  const bridgeType = switchRoomsStore.roomBridgeTypeById(roomId);
  const platform = bridgePlatformLabel(bridgeType);
  return (
    <div data-testid="agent-room-summary" className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-8 px-10 py-8">
        <div className="flex flex-col gap-1">
          <h1 className="truncate text-2xl font-semibold text-foreground">
            {name.startsWith('#') ? name : `#${name}`}
          </h1>
          <p className="text-sm text-foreground-muted">
            {summary?.bridgeDisplayName
              ? `Room bridged to ${summary.bridgeDisplayName}`
              : 'Not bridged to a messaging platform'}
          </p>
          {summary?.description && (
            <p className="pt-2 text-sm text-foreground">{summary.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="agent-room-summary-configure"
            onClick={() => openRoomView(roomId)}
          >
            <Settings className="size-3.5" />
            Room configurations
          </Button>
          {switchRoomsStore.roomChannelUrl(roomId) && (
            <Button
              variant="outline"
              size="sm"
              data-testid="agent-room-summary-open-external"
              onClick={() => openRoomChannel(roomId)}
            >
              {hasBridgeIcon(bridgeType) && (
                <BridgeIcon bridgeType={bridgeType} size={14} className="size-3.5" />
              )}
              Open in {platform}
              <ExternalLink className="size-3.5" />
            </Button>
          )}
        </div>
        <section className="flex flex-col gap-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-foreground">Participants</h2>
            {query.data && (
              <span className="text-xs text-foreground-muted">
                {membershipSummary(
                  query.data.agentIds.length,
                  query.data.connectedUserNames.length
                )}
              </span>
            )}
          </div>
          {query.isError ? (
            <p role="alert" className="text-sm text-foreground-destructive">
              {failureText(query.error, 'Could not read who is in this room.')}
            </p>
          ) : query.data && workspaceId ? (
            <ParticipantList workspaceId={workspaceId} room={query.data} />
          ) : (
            <p className="flex items-center gap-2 text-sm text-foreground-muted">
              <Loader2 className="size-3.5 animate-spin" />
              Loading participants…
            </p>
          )}
        </section>
      </div>
    </div>
  );
});
