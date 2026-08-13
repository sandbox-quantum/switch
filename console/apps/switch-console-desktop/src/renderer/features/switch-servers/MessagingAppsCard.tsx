import { useQueryClient, useQuery } from '@tanstack/react-query';
import { ExternalLink, MessageSquare, Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { Switch } from '@renderer/lib/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import type { RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import { BundledChatSignIn } from './BundledChatSignIn';
import { switchRoomsStore } from './switch-rooms-store';
import { switchServersStore } from './switch-servers-store';

/**
 * The messaging apps bridged to a server, and — for an admin — the way to
 * connect another (CHOO-1784).
 *
 * Listing is offered on every server type, not just managed ones: a bridge is
 * registered through the server's own admin API, so there is nothing
 * Switch Console has to own locally for this to work. Attaching is gated on the
 * signed-in user being an admin, because the endpoint is.
 */
export const MessagingAppsCard = observer(function MessagingAppsCard({
  serverId,
  className,
}: {
  serverId: string;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const showConnectMessagingApp = useShowModal('connectMessagingAppModal');
  const isAdmin = switchServersStore.statusFor(serverId)?.user?.role === 'admin';
  // Only a stack Switch Console runs has a chat whose credentials it generated and
  // can therefore show; anyone else's Mattermost is their own to hand out.
  const isManaged = !!switchServersStore.servers.find((s) => s.id === serverId)?.managed;

  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', serverId],
    queryFn: () => rpc.switchServers.listRemoteBridges(serverId),
    enabled: !!serverId,
  });

  const bridges = bridgesQuery.data ?? [];

  // Which bridge's channel-creation switch is mid-flight, so only that row
  // disables rather than the whole list, and the surfaced error names the one
  // connection that failed.
  const [savingBridgeId, setSavingBridgeId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const handleToggleChannelCreation = async (bridge: RemoteBridge, enabled: boolean) => {
    setSavingBridgeId(bridge.id);
    setToggleError(null);
    try {
      const result = await rpc.switchServers.updateBridge({
        serverId,
        bridgeId: bridge.id,
        channelCreationEnabled: enabled,
      });
      if (result.kind !== 'updated') {
        setToggleError(`Could not update ${bridge.displayName}: ${messageForUpdate(result)}`);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['remote-bridges', serverId] });
    } catch (cause) {
      setToggleError(
        `Could not update ${bridge.displayName}: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    } finally {
      setSavingBridgeId(null);
    }
  };

  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-foreground">Messaging apps</h3>
          {bridgesQuery.isLoading && <Spinner className="size-3.5" />}
        </div>
        {isAdmin && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              showConnectMessagingApp({
                serverId,
                onSuccess: () => {
                  // Refresh the bridge list everywhere it is consumed — this
                  // card and the room-creation picker share the query key.
                  void queryClient.invalidateQueries({ queryKey: ['remote-bridges', serverId] });
                  void switchRoomsStore.refreshRoomState();
                },
              })
            }
          >
            <Plus className="size-4" />
            Connect
          </Button>
        )}
      </div>

      {bridgesQuery.isError ? (
        <p className="text-destructive mt-3 text-xs">
          Could not load messaging apps:{' '}
          {bridgesQuery.error instanceof Error
            ? bridgesQuery.error.message
            : String(bridgesQuery.error)}
        </p>
      ) : bridges.length === 0 && !bridgesQuery.isLoading ? (
        <p className="mt-3 text-xs text-foreground-muted">
          {isAdmin
            ? 'No messaging app is connected, so rooms created here would be unreachable. Connect one to get started.'
            : 'No messaging app is connected. An admin on this server can connect one.'}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {bridges.map((bridge) => (
            <li key={bridge.id} className="text-sm">
              <div className="flex items-center gap-2">
                {hasBridgeIcon(bridge.type) ? (
                  <BridgeIcon bridgeType={bridge.type} size={16} />
                ) : (
                  <MessageSquare className="size-4 text-foreground-muted" />
                )}
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {bridge.displayName}
                </span>
                {/* Offered only when the link resolves — an older server, or a
                  bridge that is down, reports none, and a button that cannot
                  do anything is worse than no button. */}
                {bridge.homeUrl && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Open ${bridgePlatformLabel(bridge.type)}`}
                    onClick={() =>
                      void openExternalUrl(
                        bridge.homeUrl as string,
                        `Could not open ${bridgePlatformLabel(bridge.type)}`
                      )
                    }
                  >
                    <ExternalLink className="size-3.5" />
                    Open
                  </Button>
                )}
                {bridge.isDefault && <Badge variant="secondary">Default</Badge>}
                {/* Surfaced only when it is NOT active: a bridge that is down
                  cannot back a new room, and the room-creation picker silently
                  omits it, so this is where that becomes visible. */}
                {bridge.status !== 'active' && <Badge variant="destructive">{bridge.status}</Badge>}
                <TooltipProvider delay={150}>
                  <Tooltip>
                    <TooltipTrigger>
                      <span className="flex shrink-0 items-center gap-1.5 text-xs text-foreground-muted">
                        Channels
                        <Switch
                          size="sm"
                          checked={bridge.canCreateChannels}
                          disabled={
                            !isAdmin ||
                            !bridge.channelCreationSupported ||
                            savingBridgeId === bridge.id
                          }
                          onCheckedChange={(next) => void handleToggleChannelCreation(bridge, next)}
                          aria-label={`${bridge.canCreateChannels ? 'Disallow' : 'Allow'} ${bridgePlatformLabel(bridge.type)} creating channels from Switch`}
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-56 text-xs">
                      {!bridge.channelCreationSupported
                        ? `${bridgePlatformLabel(bridge.type)} cannot create channels from Switch — create the chat in the app and add the bot to it instead.`
                        : bridge.canCreateChannels
                          ? 'Can create a channel here for a new room. Turn off to only ever adopt channels made in the app.'
                          : 'Channel creation is turned off for this connection — a new room can only adopt a channel made in the app.'}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              {isManaged && bridge.type === 'mattermost' && (
                <BundledChatSignIn serverId={serverId} />
              )}
            </li>
          ))}
        </ul>
      )}
      {toggleError && <p className="text-destructive mt-2 text-xs">{toggleError}</p>}
    </div>
  );
});

/** Turn a failed channel-creation toggle into something the user can act on. */
function messageForUpdate(result: { kind: string; message?: string }): string {
  switch (result.kind) {
    case 'unauthenticated':
      return 'Your session for this server expired. Sign in again, then retry.';
    case 'forbidden':
      return 'This requires an admin account on this server.';
    default:
      return result.message ?? 'The server rejected the change.';
  }
}
