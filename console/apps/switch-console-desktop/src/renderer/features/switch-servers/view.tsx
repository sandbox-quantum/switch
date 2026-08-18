import { useQueryClient } from '@tanstack/react-query';
import {
  ExternalLink,
  House,
  MoreVertical,
  Pencil,
  PlugZap,
  RefreshCw,
  Trash2,
  Unplug,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { type GuardResult, type ViewDefinition } from '@renderer/app/view-registry';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import { HostUnreachablePanel } from '@renderer/features/remote-hosts/host-unreachable-panel';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Alert, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { localServerStore } from './local-server-store';
import { LocalServerControls } from './LocalServerControls';
import { MessagingAppsCard } from './MessagingAppsCard';
import { remoteServerStore } from './remote-server-store';
import { RemoteServerControls } from './RemoteServerControls';
import { serverIcon } from './server-icon';
import { ServerAvatar, serverDrift, serverPlacementLabel } from './server-presentation';
import { ServerResetSection } from './server-reset-section';
import { ServerSectionTitlebar } from './server-section-titlebar';
import { ServerSignInFields, useServerSignIn } from './server-sign-in';
import { ServerStatTiles } from './server-stat-tiles';
import { switchRoomsStore } from './switch-rooms-store';
import { switchServersStore } from './switch-servers-store';
import { myIdentitiesQueryKey } from './use-my-identities';
import { VersionDriftNotice } from './VersionDriftNotice';

/** Whether a managed server's stack is currently running (via the store that
 * owns its lifecycle). Non-managed servers are always "reachable". */
function isManagedRunning(server: SwitchServer): boolean {
  if (server.managementKind === 'remote' && server.sshHost) {
    return remoteServerStore.isRunning(server.sshHost);
  }
  return localServerStore.isRunning;
}

/** Re-running the start pipeline is what picks up a new switch-core pin, so
 * "restart to update" and "restart" are the same call on either store. */
function restartStack(server: SwitchServer): void {
  if (server.managementKind === 'remote' && server.sshHost) {
    void remoteServerStore.start(server.sshHost, server.name);
    return;
  }
  void localServerStore.start();
}

const card = 'rounded-lg border border-border bg-card p-4';

/** How long Refresh keeps spinning at minimum. Long enough to be seen as a
 * response to the click, short enough not to feel like waiting. */
const MIN_REFRESH_FEEDBACK_MS = 600;

function useServerId(): string {
  return useParams('server').params.serverId;
}

const ServerTitlebar = observer(function ServerTitlebar() {
  return <ServerSectionTitlebar serverId={useServerId()} icon={House} label="Home" />;
});

const ServerMainPanel = observer(function ServerMainPanel() {
  const serverId = useServerId();
  const store = switchServersStore;
  const server = store.servers.find((s) => s.id === serverId);
  const showEditServerModal = useShowModal('addServerModal');
  const showRenameServerModal = useShowModal('renameServerModal');
  const showDeleteServerModal = useShowModal('deleteServerModal');
  const { navigate } = useNavigate();
  const queryClient = useQueryClient();

  const [refreshingPage, setRefreshingPage] = useState(false);

  /**
   * Everything the page is showing, re-read.
   *
   * The button sits in the page header, so its scope has to be the page: the
   * connection alone would leave the counts, the messaging apps and the rooms
   * exactly as stale as they were, under a control that claims to have
   * refreshed them.
   *
   * Held on screen for a moment even when the reads come back instantly. A
   * spinner that appears and vanishes inside one frame reads as a button that
   * did nothing, which is the opposite of what it did.
   */
  const refreshEverything = async (): Promise<void> => {
    setRefreshingPage(true);
    try {
      await Promise.all([
        store.refreshServer(serverId),
        queryClient.invalidateQueries({ queryKey: ['remote-bridges', serverId] }),
        queryClient.invalidateQueries({ queryKey: myIdentitiesQueryKey(serverId) }),
        queryClient.invalidateQueries({ queryKey: ['owns-owner-addressed-agent', serverId] }),
        switchRoomsStore.refreshRoomState(),
        agentsStore.load(),
        new Promise((resolve) => setTimeout(resolve, MIN_REFRESH_FEEDBACK_MS)),
      ]);
    } finally {
      setRefreshingPage(false);
    }
  };

  // A managed server that isn't running has no gateway to reach — its
  // connection status, sign-in, and web-app links are meaningless until it's up,
  // so we neither fetch nor render them (only the Start/Reset controls show).
  const detailsVisible = !server?.managed || isManagedRunning(server);

  useEffect(() => {
    void hostReachabilityStore.hydrate();
  }, []);

  // A blocked host answers nothing and this page renders the host-unreachable
  // panel instead, so neither read below has a consumer while it is down.
  // Reading it here also makes the host un-blocking a recovery signal: the
  // effect re-runs and finally fetches what it skipped (CHOO-2042).
  const hostBlocked = store.isHostBlocked(serverId);

  useEffect(() => {
    if (!detailsVisible || hostBlocked) return;
    void store.refreshStatus(serverId);
    void store.ensureAuthConfig(serverId);
  }, [serverId, store, detailsVisible, hostBlocked]);

  if (!server) {
    return (
      <div className="relative z-10 flex min-h-0 flex-1 overflow-auto bg-background p-6">
        <p className="text-sm text-foreground-muted">This server is no longer available.</p>
      </div>
    );
  }

  // A remote-managed server is only as reachable as its host. While the host is
  // blocked, everything on this page (stack status, Docker, sign-in, web app)
  // would be a stale or doomed read, so the modeled host state replaces it
  // outright rather than sitting under a green badge (CHOO-1780).
  const blockedHost =
    server.managed && server.managementKind === 'remote' && server.sshHost
      ? hostReachabilityStore.get(server.sshHost)
      : null;
  if (blockedHost && hostReachabilityStore.isBlocked(blockedHost.sshHost)) {
    return (
      <div className="relative z-10 flex min-h-0 flex-1 overflow-auto bg-background">
        <HostUnreachablePanel reachability={blockedHost} />
      </div>
    );
  }

  const status = store.statusFor(serverId);
  const connected = status?.connected ?? false;
  // A background status poll spins the button too: it is the same reading the
  // button asks for, so the page should not look idle while one is in flight.
  const busy = refreshingPage || store.refreshing.has(serverId);
  const unreachable = store.isUnreachable(serverId);
  const PlacementIcon = serverIcon(server);
  const drift = serverDrift(server);
  const stackTransitioning =
    server.managementKind === 'remote' && server.sshHost
      ? remoteServerStore.isTransitioning(server.sshHost) ||
        remoteServerStore.isHostBlocked(server.sshHost)
      : localServerStore.isTransitioning;

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-auto bg-background">
      <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <header className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <ServerAvatar server={server} size="lg" />
            <h2 className="truncate text-2xl font-semibold text-foreground">{server.name}</h2>
            {/* Where the server lives, as the icon the switcher and the sidebar
              already use for it rather than as a second vocabulary in words. */}
            <PlacementIcon
              aria-label={serverPlacementLabel(server) ?? 'Reached over the network'}
              className="size-4 shrink-0 text-foreground-muted"
            />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {detailsVisible && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void refreshEverything()}
              >
                {busy ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
                Refresh
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="shrink-0"
                    aria-label="Server actions"
                  >
                    <MoreVertical className="size-4" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => showRenameServerModal({ serverId, currentName: server.name })}
                >
                  <Pencil className="size-4" />
                  Rename…
                </DropdownMenuItem>
                {!server.managed && (
                  <DropdownMenuItem
                    onClick={() =>
                      showEditServerModal({
                        serverId,
                        initialName: server.name,
                        initialGatewayUrl: server.gatewayUrl,
                        initialApiUrl: server.apiUrl,
                      })
                    }
                  >
                    <ExternalLink className="size-4" />
                    Edit connection…
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                {/* Only a server Switch Console runs is one it can delete; for
                    anyone else's, all we can do is let go of it. Both stay red:
                    either way every agent pointed at this server loses it. */}
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() =>
                    showDeleteServerModal({ serverId, onSuccess: () => navigate('home') })
                  }
                >
                  {server.managed ? <Trash2 className="size-4" /> : <Unplug className="size-4" />}
                  {server.managed ? 'Delete server…' : 'Disconnect from server…'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {store.error && (
          <Alert variant="destructive">
            <AlertTitle>{store.error}</AlertTitle>
            {store.errorDetail && <AlertDescription>{store.errorDetail}</AlertDescription>}
          </Alert>
        )}

        {/* An available update is about the whole server, so it leads the page
          rather than waiting inside the stack card further down. */}
        <VersionDriftNotice
          drift={drift}
          disabled={stackTransitioning}
          onRestart={() => restartStack(server)}
        />

        {detailsVisible && unreachable && <ServerUnreachableCard serverId={serverId} />}

        {detailsVisible && !unreachable && (
          <>
            {connected ? (
              <SignedInCard serverId={serverId} />
            ) : (
              <>
                <div className={`${card} flex items-center justify-between gap-3`}>
                  <div className="flex items-center gap-2 text-sm">
                    <StatusDot connected={false} />
                    <span className="text-foreground-muted">Not signed in</span>
                  </div>
                </div>
                <LoginPanel serverId={serverId} />
              </>
            )}

            {connected && <ServerStatTiles serverId={serverId} />}
            {connected && <MessagingAppsCard serverId={serverId} />}
          </>
        )}

        {server.managed &&
          (server.managementKind === 'remote' && server.sshHost ? (
            <RemoteServerControls sshHost={server.sshHost} name={server.name} />
          ) : (
            <LocalServerControls />
          ))}

        {detailsVisible && !unreachable && (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <h3 className="text-sm font-medium text-foreground">Full admin interface</h3>
              <p className="text-xs text-foreground-muted">
                Configure resources, API keys and users.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() =>
                void rpc.switchServers.openGatewayPage({
                  serverId: server.id,
                  url: server.gatewayUrl,
                })
              }
            >
              <ExternalLink className="size-4" />
              Open
            </Button>
          </div>
        )}

        {server.managed && (
          <ServerResetSection
            dialogTitle={
              server.managementKind === 'remote' && server.sshHost
                ? `Reset server on ${server.sshHost}`
                : 'Reset server on this computer'
            }
            disabled={stackTransitioning}
            onConfirm={() => {
              if (server.managementKind === 'remote' && server.sshHost) {
                void remoteServerStore.reset(server.sshHost);
                return;
              }
              void localServerStore.reset();
            }}
          />
        )}
      </div>
    </div>
  );
});

/**
 * Who you are on this server, and the way out.
 *
 * The account leads with a face and a name because that is the question being
 * answered — which of your identities this server sees — rather than with the
 * fact of a connection, which the titlebar's pill already carries.
 */
const SignedInCard = observer(function SignedInCard({ serverId }: { serverId: string }) {
  const store = switchServersStore;
  const user = store.statusFor(serverId)?.user;
  const displayName = user?.name || user?.email || 'Signed in';
  const initial = displayName.trim().charAt(0).toUpperCase() || '?';

  return (
    <div className={`${card} flex items-center justify-between gap-3`}>
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-background-tertiary text-sm font-medium text-foreground"
        >
          {initial}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{displayName}</p>
          <p className="truncate text-xs text-foreground-muted">
            Signed in{user?.role ? ` · ${user.role}` : ''}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {user?.role && <Badge variant="secondary">{user.role}</Badge>}
        <Button variant="outline" size="sm" onClick={() => void store.logout(serverId)}>
          Sign out
        </Button>
      </div>
    </div>
  );
});

/** How often the page re-probes a server it could not reach, while the user is
 * looking at it. Short enough to feel like it is trying, long enough not to
 * hammer a gateway that is down. */
const UNREACHABLE_RETRY_MS = 10_000;

/**
 * The whole page when a server's gateway cannot be reached. There is nothing to
 * sign into and no status worth reading, so this replaces both rather than
 * stacking a red banner on top of a sign-in form that can never work. The raw
 * gateway error stays in the console: naming our own IPC method at the user
 * gives them nothing to act on (CHOO-2042).
 */
const ServerUnreachableCard = observer(function ServerUnreachableCard({
  serverId,
}: {
  serverId: string;
}) {
  const store = switchServersStore;
  const retrying = store.refreshing.has(serverId);

  // Keep probing while this is on screen. Waiting for the user to press
  // something would leave a server that recovered looking down.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void store.refreshServer(serverId);
    }, UNREACHABLE_RETRY_MS);
    return () => clearInterval(timer);
  }, [serverId, store]);

  return (
    <div className={`${card} flex items-center justify-between gap-3`}>
      <div className="flex items-center gap-2 text-sm">
        <PlugZap className="size-4 text-amber-500" />
        <span className="text-foreground">Cannot reach the server</span>
        <span className="text-foreground-muted">
          {retrying ? 'Reconnecting…' : 'Check your connection.'}
        </span>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={retrying}
        onClick={() => void store.refreshServer(serverId)}
      >
        <RefreshCw className={retrying ? 'size-4 animate-spin' : 'size-4'} />
        Retry
      </Button>
    </div>
  );
});

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block size-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}
    />
  );
}

const LoginPanel = observer(function LoginPanel({ serverId }: { serverId: string }) {
  const signIn = useServerSignIn(serverId);

  return (
    <div className={`${card} space-y-4`}>
      <p className="text-sm text-foreground-muted">Sign in to connect to this server.</p>
      <ServerSignInFields
        signIn={signIn}
        idPrefix="switch-login"
        onSignedIn={() => {}}
        passwordSubmit={
          <Button
            size="sm"
            className="self-start"
            disabled={signIn.submitting || !signIn.canSubmitPassword}
            onClick={() => void signIn.signInWithPassword()}
          >
            {signIn.submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        }
      />
    </div>
  );
});

export const serverView = {
  WrapView: ({ children }: { children: React.ReactNode; serverId: string }) => <>{children}</>,
  TitlebarSlot: ServerTitlebar,
  MainPanel: ServerMainPanel,
  canActivate: (params: unknown): GuardResult => {
    const serverId =
      typeof params === 'object' && params !== null
        ? (params as { serverId?: unknown }).serverId
        : undefined;
    if (typeof serverId !== 'string') {
      return { ok: false, redirect: 'home' };
    }
    return { ok: true };
  },
} satisfies ViewDefinition<{ serverId: string }>;
