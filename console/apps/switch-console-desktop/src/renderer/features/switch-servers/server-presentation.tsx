import { ArrowUpCircle, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import type { SwitchVersionDrift } from '@shared/core/managed-switch-server/managed-switch-server';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { localServerStore } from './local-server-store';
import { remoteServerStore } from './remote-server-store';
import { serverAvailability } from './server-availability';

/**
 * How a server presents itself wherever it is listed — the switcher button, the
 * switcher menu, the titlebar. Kept in one place so those three cannot describe
 * the same server differently.
 */
export type ServerState =
  | 'host-unreachable'
  | 'not-running'
  | 'unreachable'
  | 'signed-out'
  | 'running-local'
  | 'connected';

export function serverState(server: SwitchServer): ServerState {
  if (
    server.managementKind === 'remote' &&
    server.sshHost &&
    hostReachabilityStore.isBlocked(server.sshHost)
  ) {
    return 'host-unreachable';
  }
  switch (serverAvailability(server.id)) {
    case 'dormant':
      return 'not-running';
    case 'unreachable':
      return 'unreachable';
    case 'signed-out':
      return 'signed-out';
    case 'available':
      return server.managed && server.managementKind !== 'remote' ? 'running-local' : 'connected';
  }
}

const STATE_LABEL: Record<ServerState, string> = {
  'host-unreachable': 'Host unreachable',
  'not-running': 'Not running',
  unreachable: 'Unreachable',
  'signed-out': 'Signed out',
  'running-local': 'Running',
  connected: 'Connected',
};

/** The state as a listed server reads it, next to its placement badge. */
export function serverStatusLabel(server: SwitchServer): string {
  return STATE_LABEL[serverState(server)];
}

/**
 * The state as the switcher button reads it. It has no placement badge beside
 * it — the whole button is the one server — so the local stack says where it
 * runs here instead.
 */
const SUBTITLE_LABEL: Record<ServerState, string> = {
  ...STATE_LABEL,
  'running-local': 'Running locally',
};

export function serverSubtitleLabel(server: SwitchServer): string {
  return SUBTITLE_LABEL[serverState(server)];
}

/** Where a server runs. Null for one reached by URL: this app does not know. */
export function serverPlacementLabel(server: SwitchServer): string | null {
  if (!server.managed) return null;
  if (server.managementKind === 'remote') return server.sshHost ?? 'Remote';
  return 'This computer';
}

/**
 * Drift is reported for a stopped stack too — its volumes still hold the schema
 * the last version migrated to — so this is deliberately not gated on the stack
 * running.
 */
export function serverDrift(server: SwitchServer): SwitchVersionDrift | null {
  if (!server.managed) return null;
  if (server.managementKind === 'remote' && server.sshHost) {
    return remoteServerStore.driftFor(server.sshHost);
  }
  return localServerStore.drift;
}

const AVATAR_SIZE = {
  sm: 'size-6 text-xs',
  md: 'size-[26px] text-xs',
  lg: 'size-9 rounded-lg text-lg',
} as const;

export function ServerAvatar({
  server,
  size,
}: {
  server: SwitchServer;
  size: keyof typeof AVATAR_SIZE;
}) {
  const initial = server.name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg bg-[var(--accent-solid)] font-semibold text-white',
        AVATAR_SIZE[size]
      )}
    >
      {initial}
    </span>
  );
}

/**
 * Whether this server can be reached right now. Amber would read as "warming
 * up"; neither signed-out nor unreachable is transitional, so both are red and
 * only a stack that is not running is neutral.
 */
export const ServerStatusDot = observer(function ServerStatusDot({
  server,
}: {
  server: SwitchServer;
}) {
  const state = serverState(server);
  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        state === 'not-running'
          ? 'bg-foreground-muted'
          : state === 'connected' || state === 'running-local'
            ? 'bg-green-500'
            : 'bg-red-500'
      )}
    />
  );
});

/**
 * The connection state as a titlebar reads it. Every page that belongs to a
 * server carries it, including an agent's own page — an agent is unreachable
 * for exactly as long as its server is, and that is worth saying where you are
 * about to start a session rather than only on the server's pages.
 */
export const ServerStatusPill = observer(function ServerStatusPill({
  server,
}: {
  server: SwitchServer;
}) {
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-background-tertiary px-2 py-0.5 text-xs text-foreground-muted">
      <ServerStatusDot server={server} />
      {serverStatusLabel(server)}
    </span>
  );
});

/**
 * Flags a managed server whose switch-core no longer matches the version this
 * build pins (CHOO-1736), so an available update is visible from the switcher
 * rather than only on the server's own page.
 *
 * Sits beside the connection dot rather than recolouring it: the dot answers
 * "can I reach this server", which stays true of a server running a stale core.
 */
export function ServerDriftIndicator({ drift }: { drift: SwitchVersionDrift }) {
  const upgrade = drift.direction === 'upgrade';
  const label = upgrade
    ? `switch-core ${drift.expected} is available (running ${drift.deployed})`
    : drift.direction === 'downgrade'
      ? `Runs switch-core ${drift.deployed} — newer than this app expects (${drift.expected})`
      : drift.direction === 'unreadable'
        ? `Can't read which switch-core this runs; this app expects ${drift.expected}`
        : `Runs switch-core ${drift.deployed}; this app expects ${drift.expected}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            className={cn(
              'flex shrink-0 items-center',
              upgrade ? 'text-foreground-warning' : 'text-red-500'
            )}
          >
            {upgrade ? (
              <ArrowUpCircle className="size-3.5" />
            ) : (
              <TriangleAlert className="size-3.5" />
            )}
          </span>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
