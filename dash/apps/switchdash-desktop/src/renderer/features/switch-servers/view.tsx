import { ExternalLink, MoreVertical, Pencil, PlugZap, RefreshCw, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { type GuardResult, type ViewDefinition } from '@renderer/app/view-registry';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import { HostUnreachablePanel } from '@renderer/features/remote-hosts/host-unreachable-panel';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
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
import { Input } from '@renderer/lib/ui/input';
import { Label } from '@renderer/lib/ui/label';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { localServerStore } from './local-server-store';
import { LocalServerControls } from './LocalServerControls';
import { MessagingAppsCard } from './MessagingAppsCard';
import { remoteServerStore } from './remote-server-store';
import { RemoteServerControls } from './RemoteServerControls';
import { switchServersStore } from './switch-servers-store';

/** Short badge label for where a server lives (see CHOO-1432 terminology). */
function serverLocationLabel(server: SwitchServer): string | null {
  if (server.managementKind === 'remote') return server.sshHost ?? 'Remote host';
  if (server.managed) return 'This computer';
  return 'External';
}

/** Whether a managed server's stack is currently running (via the store that
 * owns its lifecycle). Non-managed servers are always "reachable". */
function isManagedRunning(server: SwitchServer): boolean {
  if (server.managementKind === 'remote' && server.sshHost) {
    return remoteServerStore.isRunning(server.sshHost);
  }
  return localServerStore.isRunning;
}

const card = 'rounded-lg border border-border bg-card p-4';

function useServerId(): string {
  return useParams('server').params.serverId;
}

const ServerTitlebar = observer(function ServerTitlebar() {
  const serverId = useServerId();
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  return (
    <Titlebar
      leftSlot={
        <div className="flex items-center px-2">
          <span className="text-sm text-foreground-muted">{server?.name ?? 'Server'}</span>
        </div>
      }
    />
  );
});

const ServerMainPanel = observer(function ServerMainPanel() {
  const serverId = useServerId();
  const store = switchServersStore;
  const server = store.servers.find((s) => s.id === serverId);
  const showEditServerModal = useShowModal('addServerModal');
  const showRenameServerModal = useShowModal('renameServerModal');
  const showDeleteServerModal = useShowModal('deleteServerModal');
  const { navigate } = useNavigate();

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
  const refreshing = store.refreshing.has(serverId);

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-auto bg-background">
      <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="text-xl text-foreground">{server.name}</h2>
              {serverLocationLabel(server) && (
                <Badge variant="secondary">{serverLocationLabel(server)}</Badge>
              )}
            </div>
            <p className="truncate text-sm text-foreground-muted">{server.gatewayUrl}</p>
            <p className="truncate text-xs text-foreground-tertiary-passive">
              API: {server.apiUrl}
            </p>
          </div>
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
              <DropdownMenuItem
                variant="destructive"
                onClick={() =>
                  showDeleteServerModal({ serverId, onSuccess: () => navigate('home') })
                }
              >
                <Trash2 className="size-4" />
                Delete server…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {store.error && (
          <Alert variant="destructive">
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>{store.error}</AlertDescription>
          </Alert>
        )}

        {server.managed &&
          (server.managementKind === 'remote' && server.sshHost ? (
            <RemoteServerControls sshHost={server.sshHost} name={server.name} />
          ) : (
            <LocalServerControls />
          ))}

        {detailsVisible && store.isUnreachable(serverId) && (
          <ServerUnreachableCard serverId={serverId} />
        )}

        {detailsVisible && !store.isUnreachable(serverId) && (
          <>
            <div className={`${card} flex items-center justify-between gap-3`}>
              <div className="flex items-center gap-2 text-sm">
                <StatusDot connected={connected} />
                {connected ? (
                  <span className="text-foreground">
                    Connected{status?.user ? ` as ${status.user.name || status.user.email}` : ''}
                  </span>
                ) : (
                  <span className="text-foreground-muted">Not signed in</span>
                )}
                {status?.user?.role && <Badge variant="secondary">{status.user.role}</Badge>}
                {refreshing && <Spinner className="size-3.5" />}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={refreshing}
                  onClick={() => void store.refreshServer(serverId)}
                >
                  <RefreshCw className="size-4" />
                  Refresh
                </Button>
                {connected && (
                  <Button variant="ghost" size="sm" onClick={() => void store.logout(serverId)}>
                    Sign out
                  </Button>
                )}
              </div>
            </div>

            {!connected && <LoginPanel serverId={serverId} />}

            {connected && <MessagingAppsCard serverId={serverId} className={card} />}

            <div className={`${card} space-y-3`}>
              <p className="text-sm text-foreground-muted">
                Configure resources, API keys and users in the full admin interface.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void rpc.switchServers.openGatewayPage({
                    serverId: server.id,
                    url: server.gatewayUrl,
                  })
                }
              >
                <ExternalLink className="size-4" />
                Open admin interface
              </Button>
            </div>
          </>
        )}
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
  const store = switchServersStore;
  const config = store.authConfigFor(serverId);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const doPasswordLogin = async () => {
    setSubmitting(true);
    try {
      await store.passwordLogin(serverId, email, password);
    } finally {
      setSubmitting(false);
    }
  };

  const doOidcLogin = async () => {
    setSubmitting(true);
    try {
      await store.oidcLogin(serverId);
    } finally {
      setSubmitting(false);
    }
  };

  if (!config) {
    return <div className={card}>Checking sign-in options…</div>;
  }

  return (
    <div className={`${card} space-y-4`}>
      <p className="text-sm text-foreground-muted">Sign in to connect to this server.</p>

      {config.passwordLoginEnabled && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="switch-login-email">Email</Label>
            <Input
              id="switch-login-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="switch-login-password">Password</Label>
            <Input
              id="switch-login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doPasswordLogin();
              }}
            />
          </div>
          <Button
            size="sm"
            disabled={submitting || !email || !password}
            onClick={() => void doPasswordLogin()}
          >
            Sign in
          </Button>
        </div>
      )}

      {config.oidcEnabled && (
        <div className="space-y-2">
          {config.passwordLoginEnabled && (
            <div className="text-xs tracking-wide text-foreground-passive uppercase">or</div>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={submitting}
            onClick={() => void doOidcLogin()}
          >
            Sign in with {config.oidcProviderLabel ?? 'SSO'}
          </Button>
        </div>
      )}

      {!config.passwordLoginEnabled && !config.oidcEnabled && (
        <Alert variant="destructive">
          <AlertDescription>This server has no enabled login methods.</AlertDescription>
        </Alert>
      )}
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
