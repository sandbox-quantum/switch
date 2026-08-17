import { useQueryClient, useQuery } from '@tanstack/react-query';
import {
  CircleAlert,
  ExternalLink,
  Info,
  Link2,
  MessageSquare,
  MoreVertical,
  Plus,
  Trash2,
  TriangleAlert,
  Unlink,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Spinner } from '@renderer/lib/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { log } from '@renderer/utils/logger';
import type { LinkedIdentity, RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import { BundledChatSignIn } from './BundledChatSignIn';
import { orderBridges } from './messaging-apps-order';
import {
  hasUnlinkedMessagingApp,
  shouldOfferIdentityLinkOnConnect,
  unrecognisedMessagingApps,
  unrecognisedMessagingAppsMessage,
} from './messaging-apps-warning';
import { switchRoomsStore } from './switch-rooms-store';
import { switchServersStore } from './switch-servers-store';
import { useMyIdentities } from './use-my-identities';

/**
 * The messaging apps bridged to a server, which account in each one is the
 * signed-in user, and — for an admin — the way to connect another
 * (CHOO-1784, CHOO-2137).
 *
 * One row per app: its name with the account you have claimed on it underneath,
 * a Link button while you have not, and a menu holding everything else. Read
 * far more often than changed, so it is a list rather than a table of controls
 * — the settings that used to be columns are in the menu, where they cost
 * nothing to ignore.
 *
 * Listing is offered on every server type, not just managed ones: a bridge is
 * registered through the server's own admin API, so there is nothing
 * Switch Console has to own locally for this to work. Attaching is gated on the
 * signed-in user being an admin, because the endpoint is; linking an account is
 * not, because claiming an identity is something every user does for themselves.
 */
/** Why a server has messaging apps at all: the agents registered here become
 * reachable in them. Linking is deliberately not explained here — it has its
 * own hover on the rows and the warning that are actually about it, and saying
 * both on the heading made the section's purpose the smaller half of a wall of
 * text. */
const MESSAGING_APPS_PURPOSE =
  'Connecting a messaging app puts this server’s agents in it, so you can talk to them where you already work.';

/** Shown beside a row that has no linked account, and beside the card-level
 * warning, so the consequence is one hover away from the thing warning about
 * it rather than only in the section heading. */
const NO_ACCOUNT_EXPLANATION =
  'Switch cannot tell which account in this app is you. Agents set to answer only their owner will not recognise you here, and messages from you read as if from a stranger.';

export const MessagingAppsCard = observer(function MessagingAppsCard({
  serverId,
  className,
}: {
  serverId: string;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const showConnectMessagingApp = useShowModal('connectMessagingAppModal');
  const showClaimIdentity = useShowModal('claimIdentityModal');
  const showDisconnectMessagingApp = useShowModal('disconnectMessagingAppModal');
  const isAdmin = switchServersStore.statusFor(serverId)?.user?.role === 'admin';
  // Only a stack Switch Console runs has a chat whose credentials it generated and
  // can therefore show; anyone else's Mattermost is their own to hand out.
  const isManaged = !!switchServersStore.servers.find((s) => s.id === serverId)?.managed;

  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', serverId],
    queryFn: () => rpc.switchServers.listRemoteBridges(serverId),
    enabled: !!serverId,
  });

  const bridges = useMemo(() => orderBridges(bridgesQuery.data ?? []), [bridgesQuery.data]);

  const {
    identities,
    error: identitiesError,
    refresh: refreshIdentities,
  } = useMyIdentities(serverId);
  // Whose claim to drop when unlinking. Every account here is one the signed-in
  // user claimed, and other people may hold the same one — so name the user
  // rather than let the server infer it. Null until the session is read back,
  // where the server falls back to the caller, which is the same person.
  const currentUserId = switchServersStore.statusFor(serverId)?.user?.id ?? null;

  // Whether an unlinked app actually costs this user anything. Asked only once
  // the cheap half of the condition holds — there is an app they have not
  // linked — because a user who has linked everywhere has nothing to be warned
  // about, so the answer would go nowhere. The probe itself is one agent-list
  // read, so it is not cached beyond that: linking an account or changing an
  // agent's policy should stop the warning on the next look, not a minute later.
  const anyUnlinked = hasUnlinkedMessagingApp(bridges, identities);
  const ownerAgentsQuery = useQuery({
    queryKey: ['owns-owner-addressed-agent', serverId],
    queryFn: () => rpc.switchServers.ownsOwnerAddressedAgent(serverId),
    enabled: !!serverId && anyUnlinked,
  });
  // The probe failing costs no data on screen, only the warning — so it is
  // logged rather than shown, and the card does not warn on a guess.
  const ownerAgentsError = ownerAgentsQuery.error;
  useEffect(() => {
    if (ownerAgentsError) {
      log.warn('Could not check for owner-addressed agents', {
        serverId,
        error: ownerAgentsError,
      });
    }
  }, [ownerAgentsError, serverId]);

  const unrecognisedIn = unrecognisedMessagingApps({
    bridges,
    identities,
    ownsOwnerAddressedAgent: ownerAgentsQuery.isSuccess ? ownerAgentsQuery.data : null,
  });

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
          {/* What the section is for, in the order the two facts matter:
              connecting puts the agents somewhere people already are, and
              linking is what lets those agents tell who is talking to them.
              It used to be the "Your account" column's header tooltip; with
              the columns gone it belongs to the heading. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  tabIndex={0}
                  aria-label={MESSAGING_APPS_PURPOSE}
                  className="inline-flex text-foreground-muted"
                >
                  <Info className="size-3.5" />
                </span>
              }
            />
            <TooltipContent className="max-w-xs">{MESSAGING_APPS_PURPOSE}</TooltipContent>
          </Tooltip>
          {bridgesQuery.isLoading && <Spinner className="size-3.5" />}
        </div>
        {isAdmin && (
          <Button
            size="sm"
            onClick={() =>
              showConnectMessagingApp({
                serverId,
                onSuccess: ({ bridgeId, directorySearchSupported }) => {
                  // Refresh the bridge list everywhere it is consumed — this
                  // card and the room-creation picker share the query key.
                  void queryClient.invalidateQueries({ queryKey: ['remote-bridges', serverId] });
                  void switchRoomsStore.refreshRoomState();
                  // Step 2 of connecting a workspace: say which account in it
                  // is yours (CHOO-2137). Offered here because this is the one
                  // moment the workspace is on the user's mind, and it is
                  // skippable — the new bridge's own row reopens it later.
                  //
                  // Not offered at all on a platform with no searchable
                  // directory: Switch can only name people who have spoken to
                  // it there, and nobody has spoken to a connection made a
                  // second ago. The search would be guaranteed empty, which
                  // teaches the user that they are not in their own workspace.
                  // Linking waits for the server page, by which time someone
                  // has messaged the app and there is a name to pick.
                  if (shouldOfferIdentityLinkOnConnect({ directorySearchSupported })) {
                    showClaimIdentity({ serverId, bridgeId });
                  }
                },
              })
            }
          >
            <Plus className="size-4" />
            Connect
          </Button>
        )}
      </div>

      {/* Same shape as the addressing editor's owner warning, so the two
        readings of one problem look like one problem.

        The warning states the consequence itself, and each unlinked row below
        carries the longer explanation — a third hover here was one more thing
        to hover for something already said. */}
      {unrecognisedIn.length > 0 && (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <span>{unrecognisedMessagingAppsMessage(unrecognisedIn)}</span>
        </div>
      )}

      {identitiesError !== null && (
        <p className="text-destructive mt-2 text-xs">
          {failureText(
            identitiesError,
            'Could not load which messaging accounts are linked to you, so this list may be incomplete.'
          )}
        </p>
      )}

      {bridgesQuery.isError ? (
        <p className="text-destructive mt-3 text-xs">
          {failureText(
            bridgesQuery.error,
            'Could not load this server’s messaging apps. Re-check the server, or reload the page.'
          )}
        </p>
      ) : bridges.length === 0 && !bridgesQuery.isLoading ? (
        <p className="mt-3 text-xs text-foreground-muted">
          {isAdmin
            ? 'No messaging app is connected, so rooms created here would be unreachable. Connect one to get started.'
            : 'No messaging app is connected. An admin on this server can connect one.'}
        </p>
      ) : (
        <div className="mt-2 flex flex-col">
          {bridges.map((bridge) => (
            <MessagingAppRow
              key={bridge.id}
              serverId={serverId}
              bridge={bridge}
              /* Nothing is drawn in the identity column until the list
                    arrives: "not linked" and "not known yet" look identical,
                    and offering to link an account the user already has is the
                    more confusing of the two. */
              identities={identities}
              currentUserId={currentUserId}
              onReleased={refreshIdentities}
              showBundledSignIn={isManaged && bridge.type === 'mattermost'}
              isAdmin={isAdmin}
              savingChannelCreation={savingBridgeId === bridge.id}
              onToggleChannelCreation={(enabled) =>
                void handleToggleChannelCreation(bridge, enabled)
              }
              onDisconnect={() =>
                showDisconnectMessagingApp({
                  serverId,
                  bridgeId: bridge.id,
                  bridgeDisplayName: bridge.displayName,
                  onSuccess: () => {
                    void queryClient.invalidateQueries({
                      queryKey: ['remote-bridges', serverId],
                    });
                    // The rooms on that bridge went with it, so the sidebar
                    // is stale in a way the bridge list alone does not
                    // repair.
                    void switchRoomsStore.refreshRoomState();
                  },
                })
              }
            />
          ))}
        </div>
      )}
      {toggleError && <p className="text-destructive mt-2 text-xs">{toggleError}</p>}
    </div>
  );
});

/**
 * One app: its name, which account on it is the signed-in user, whether Switch
 * may open channels on it, and a menu of everything else.
 *
 * Only Link stays outside the menu: an app you have not claimed an account on
 * has exactly one thing worth doing to it, and burying that is what would make
 * the row's warning unactionable. Everything else — changing or dropping the
 * account, channel creation, the bundled chat's credentials, opening the app,
 * disconnecting it — is in the menu.
 */
export function MessagingAppRow({
  serverId,
  bridge,
  identities,
  currentUserId,
  onReleased,
  showBundledSignIn,
  isAdmin,
  savingChannelCreation,
  onToggleChannelCreation,
  onDisconnect,
}: {
  serverId: string;
  bridge: RemoteBridge;
  /** Accounts the user has claimed on this server, or null while unknown. */
  identities: LinkedIdentity[] | null;
  currentUserId: string | null;
  onReleased: () => void;
  showBundledSignIn: boolean;
  isAdmin: boolean;
  savingChannelCreation: boolean;
  onToggleChannelCreation: (enabled: boolean) => void;
  onDisconnect: () => void;
}) {
  const showClaimIdentity = useShowModal('claimIdentityModal');
  const [releasing, setReleasing] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);

  const identity = identities?.find((i) => i.bridgeId === bridge.id) ?? null;
  const platform = bridgePlatformLabel(bridge.type);
  const claim = () => showClaimIdentity({ serverId, bridgeId: bridge.id });

  const release = async (identityId: string) => {
    setReleasing(true);
    setReleaseError(null);
    try {
      await rpc.switchServers.releaseBridgeIdentity({
        serverId,
        bridgeId: bridge.id,
        identityId,
        userId: currentUserId,
      });
      onReleased();
    } catch (cause) {
      setReleaseError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReleasing(false);
    }
  };

  // Why the switch cannot be moved, when it cannot. Said in a tooltip rather
  // than left to a greyed control, because "off" and "this platform cannot do
  // it at all" are different claims and look identical otherwise.
  const channelsLockedReason = !bridge.channelCreationSupported
    ? `${platform} cannot create channels from Switch. Make the chat in the app and add the bot to it.`
    : !isAdmin
      ? 'Only an admin on this server can change this.'
      : null;

  return (
    <div className="flex items-center gap-3 py-2 text-sm">
      <span className="flex size-5 shrink-0 items-center justify-center">
        {hasBridgeIcon(bridge.type) ? (
          <BridgeIcon bridgeType={bridge.type} size={16} />
        ) : (
          <MessageSquare className="size-4 text-foreground-muted" />
        )}
      </span>

      {/* Name over account: the account is a property of the app, so it reads
          under its name rather than in a column of its own. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-foreground">{bridge.displayName}</span>
          {bridge.isDefault && <Badge variant="secondary">Default</Badge>}
          {/* Only when it is NOT active, and never otherwise. A bridge that is
              down cannot back a new room and the room-creation picker omits it
              silently, so without this the app simply is not in the list and
              nothing anywhere says why. */}
          {bridge.status !== 'active' && (
            <span className="text-destructive shrink-0 text-xs">{bridge.status}</span>
          )}
        </div>
        {identities === null ? null : identity === null ? (
          <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
            <TriangleAlert className="size-3 shrink-0" />
            No account linked
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    tabIndex={0}
                    aria-label={NO_ACCOUNT_EXPLANATION}
                    className="inline-flex text-foreground-muted"
                  >
                    <Info className="size-3" />
                  </span>
                }
              />
              <TooltipContent className="max-w-xs">{NO_ACCOUNT_EXPLANATION}</TooltipContent>
            </Tooltip>
          </span>
        ) : (
          <span className="truncate font-mono text-xs text-foreground-muted">
            {handleOf(identity)}
          </span>
        )}
        {releaseError !== null && <p className="text-destructive mt-0.5 text-xs">{releaseError}</p>}
      </div>

      {/* Linking is the one thing an unlinked app needs, so it stays a button
          rather than going into the menu with the rest. A linked app shows no
          button at all: the only thing left to do to it is destructive, and a
          control next to the handle would sit one mis-click from the action
          that *changes* the account (CHOO-2137). */}
      {identities !== null && identity === null && (
        <Button variant="outline" size="xs" className="shrink-0" onClick={claim}>
          <Link2 className="size-3" />
          Link
        </Button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0"
              aria-label={`${bridge.displayName} actions`}
              disabled={releasing}
            >
              <MoreVertical className="size-3" />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={claim}>
            <Link2 className="size-4" />
            {identity === null ? 'Link my account…' : 'Change my account…'}
          </DropdownMenuItem>
          {identity !== null && (
            <DropdownMenuItem onClick={() => void release(identity.id)}>
              <Unlink className="size-4" />
              Unlink {handleOf(identity)}
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />
          {/* "Off" and "this platform has no such thing" are different claims,
              and an unticked box makes them look the same (CHOO-2137). A
              platform that cannot do it at all gets a plain disabled line
              saying so, never an unchecked box. */}
          {bridge.channelCreationSupported ? (
            <DropdownMenuCheckboxItem
              checked={bridge.canCreateChannels}
              disabled={!isAdmin || savingChannelCreation}
              onCheckedChange={(next) => onToggleChannelCreation(next)}
            >
              Create channels on {platform}
            </DropdownMenuCheckboxItem>
          ) : (
            <DropdownMenuItem disabled>Channels not supported on {platform}</DropdownMenuItem>
          )}
          {channelsLockedReason !== null && (
            <p className="px-2 py-1 text-xs text-foreground-muted">{channelsLockedReason}</p>
          )}

          {(showBundledSignIn || bridge.homeUrl) && <DropdownMenuSeparator />}
          {showBundledSignIn && (
            <BundledChatSignIn
              serverId={serverId}
              bridgeDisplayName={bridge.displayName}
              asMenuItem
            />
          )}
          {/* Offered only when the link resolves — an older server, or a bridge
              that is down, reports none. */}
          {bridge.homeUrl && (
            <DropdownMenuItem
              onClick={() =>
                void openExternalUrl(bridge.homeUrl as string, `Could not open ${platform}`)
              }
            >
              <ExternalLink className="size-4" />
              Open in {platform}
            </DropdownMenuItem>
          )}

          {isAdmin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDisconnect}>
                <Trash2 className="size-4" />
                Disconnect app…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The claimed account as a handle. Platforms differ on whether the username
 * they report already carries the sigil, so add one only when it is missing. */
function handleOf(identity: LinkedIdentity): string {
  const username = identity.externalUsername;
  return username.startsWith('@') ? username : `@${username}`;
}

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
