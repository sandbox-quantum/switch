import { MessageSquare } from 'lucide-react';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { cn } from '@renderer/utils/utils';
import type { LinkedIdentity, RemoteBridge } from '@shared/core/switch-servers/switch-servers';

/** The claimed account as a handle. Platforms differ on whether the username
 * they report already carries the sigil, so add one only when it is missing. */
export function handleOf(identity: LinkedIdentity): string {
  const username = identity.externalUsername;
  return username.startsWith('@') ? username : `@${username}`;
}

/**
 * Why a bridge cannot back a new room right now, or null when it can.
 *
 * `needsChannelCreation` is for surfaces that will create a channel on the
 * bridge; a surface that only names the bridge (a template param) needs it
 * running and nothing more.
 */
export function bridgeUnusableReason(
  bridge: RemoteBridge,
  { needsChannelCreation }: { needsChannelCreation: boolean }
): string | null {
  if (bridge.status !== 'active') return 'Not running';
  if (!needsChannelCreation) return null;
  const platform = bridgePlatformLabel(bridge.type);
  if (!bridge.channelCreationSupported) return `${platform} cannot create channels`;
  if (!bridge.canCreateChannels) return 'Channel creation is off';
  return null;
}

/**
 * One messaging app to choose from, with the account on it that is you.
 *
 * An unusable app is shown but not selectable, and says which of the ways it
 * is unusable: an app that is simply absent from the grid explains nothing,
 * and the user goes looking for it.
 */
export function BridgeTile({
  bridge,
  identity,
  identitiesKnown,
  unusable,
  selected,
  onSelect,
}: {
  bridge: RemoteBridge;
  identity: LinkedIdentity | null;
  /** False while the identity list has not arrived: "no account linked" is
   * only true once the list says so. */
  identitiesKnown: boolean;
  /** From `bridgeUnusableReason`, or null when selectable. */
  unusable: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={unusable !== null}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-[10px] border p-3 text-left transition-colors',
        // Overlay tokens rather than `background-1`, which in dark mode is
        // exactly the dialog's own surface: the hover was being drawn, in the
        // colour of the thing behind it.
        selected ? 'border-foreground bg-[var(--sel)]' : 'border-border hover:bg-[var(--sel-soft)]',
        unusable !== null && 'cursor-not-allowed opacity-50 hover:bg-transparent'
      )}
    >
      <span className="flex size-6 shrink-0 items-center justify-center">
        {hasBridgeIcon(bridge.type) ? (
          <BridgeIcon bridgeType={bridge.type} size={20} />
        ) : (
          <MessageSquare className="size-5 text-foreground-muted" />
        )}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-foreground">{bridge.displayName}</span>
        {/* Three different things, never conflated: why this app cannot be
            used, which account on it is you, or that Switch cannot tell. */}
        {unusable !== null ? (
          <span className="truncate text-xs text-foreground-muted">{unusable}</span>
        ) : !identitiesKnown ? null : identity === null ? (
          <span className="truncate text-xs text-amber-600 dark:text-amber-500">
            No account linked
          </span>
        ) : (
          <span className="truncate text-xs text-foreground-muted">{handleOf(identity)}</span>
        )}
      </span>
    </button>
  );
}
