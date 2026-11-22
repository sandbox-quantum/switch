import { PlugZap, RefreshCw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect } from 'react';
import { type GuardResult, type ViewDefinition } from '@renderer/app/view-registry';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import { HostUnreachablePanel } from '@renderer/features/remote-hosts/host-unreachable-panel';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { Alert, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { type SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { homeRedirect } from './home-target';
import { HomeFooter } from './home/home-footer';
import { HomeHeader } from './home/home-header';
import { AskBuddyPanel, ConnectAiPanel, SignedOutPanel, useHomeChips } from './home/home-panels';
import { type HomeState, homeState } from './home/home-state';
import { useAiConnected } from './home/use-ai-connected';
import { localServerStore } from './local-server-store';
import { remoteServerStore } from './remote-server-store';
import { switchServersStore } from './switch-servers-store';

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

/** Home's header sits where the other workspace pages keep their breadcrumb. */
const ServerTitlebar = observer(function ServerTitlebar() {
  const serverId = useServerId();
  const store = switchServersStore;
  const server = store.servers.find((s) => s.id === serverId);
  const detailsVisible = !server?.managed || isManagedRunning(server);
  return (
    <Titlebar
      leftSlot={
        server && (
          <HomeHeader
            server={server}
            canRefresh={detailsVisible && !store.isHostBlocked(serverId)}
          />
        )
      }
    />
  );
});

const ServerMainPanel = observer(function ServerMainPanel() {
  const serverId = useServerId();
  const store = switchServersStore;
  const server = store.servers.find((s) => s.id === serverId);

  // A managed server that isn't running has no gateway to reach — its
  // connection status and sign-in are meaningless until it's up, so we neither
  // fetch nor render them (the workspace banner says it is down, with the way
  // to start it and to its status page).
  const detailsVisible = !server?.managed || isManagedRunning(server);

  useEffect(() => {
    void hostReachabilityStore.hydrate();
  }, []);

  // A blocked host answers nothing and this page renders the host-unreachable
  // panel instead, so neither read below has a consumer while it is down.
  // Reading it here also makes the host un-blocking a recovery signal: the
  // effect re-runs and finally fetches what it skipped (CHOO-2042).
  const hostBlocked = store.isHostBlocked(serverId);

  // An id naming no server resolves to nothing on the main side, so both reads
  // would fail — and mark the server unreachable, which is a different claim
  // from the truth that it is gone. The page says so below instead.
  const serverExists = server !== undefined;
  useEffect(() => {
    if (!serverExists || !detailsVisible || hostBlocked) return;
    void store.refreshStatus(serverId);
    void store.ensureAuthConfig(serverId);
  }, [serverId, store, serverExists, detailsVisible, hostBlocked]);

  if (!server) {
    return (
      <div className="relative z-10 flex min-h-0 flex-1 overflow-auto bg-background p-6">
        <p className="text-sm text-foreground-muted">This server is no longer available.</p>
      </div>
    );
  }

  const workspaceId = workspacesStore.idOnServerInScope(serverId);

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-auto bg-background">
      {store.error && (
        <div className="mx-auto w-full max-w-[720px] px-6 pt-2">
          <Alert variant="destructive">
            <AlertTitle>{store.error}</AlertTitle>
            {store.errorDetail && <AlertDescription>{store.errorDetail}</AlertDescription>}
          </Alert>
        </div>
      )}
      {/* Keyed by workspace: switching while one is loading starts over, and
          nothing read for the last one is shown for the next. */}
      <HomeBody
        key={`${serverId}:${workspaceId ?? ''}`}
        server={server}
        workspaceId={workspaceId}
      />
      <HomeFooter />
    </div>
  );
});

/** Everything between the header and the footer, by {@link homeState}. */
const HomeBody = observer(function HomeBody({
  server,
  workspaceId,
}: {
  server: SwitchServer;
  workspaceId: string | null;
}) {
  const store = switchServersStore;
  const serverId = server.id;
  const reducedMotion = useReducedMotion() ?? false;

  // A remote-managed server is only as reachable as its host. While the host is
  // blocked, everything on this page would be a stale or doomed read, so the
  // modeled host state replaces it outright (CHOO-1780).
  const blockedHost =
    server.managed && server.managementKind === 'remote' && server.sshHost
      ? hostReachabilityStore.get(server.sshHost)
      : null;
  const hostBlocked = blockedHost !== null && hostReachabilityStore.isBlocked(blockedHost.sshHost);
  const stopped = server.managed && !isManagedRunning(server);
  const unreachable = store.isUnreachable(serverId);
  const status = store.statusFor(serverId);
  const signedIn = status === null ? null : status.connected;
  const active = signedIn === true && !hostBlocked && !stopped && !unreachable;

  const ai = useAiConnected(serverId, workspaceId, active);
  const chips = useHomeChips(serverId, workspaceId, ai.buddy);
  const state = homeState({
    hostBlocked,
    stopped,
    unreachable,
    signedIn,
    aiConnected: ai.connected,
    suggestionsReady: chips !== null,
  });

  const content = ((): React.ReactNode => {
    switch (state) {
      case 'hostUnreachable':
        return blockedHost && <HostUnreachablePanel reachability={blockedHost} />;
      case 'stopped':
        return null;
      case 'unreachable':
        return (
          <div className="w-full max-w-[720px]">
            <ServerUnreachableCard server={server} />
          </div>
        );
      case 'signedOut':
        return <SignedOutPanel serverId={serverId} />;
      case 'loading':
        return <Spinner className="size-6 text-foreground-muted" />;
      case 'connectAi':
        return <ConnectAiPanel serverId={serverId} workspaceId={workspaceId} />;
      case 'askBuddy':
        return (
          ai.buddy && <AskBuddyPanel serverId={serverId} buddy={ai.buddy} chips={chips ?? []} />
        );
    }
  })();

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-8">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={state satisfies HomeState}
          className="flex w-full flex-col items-center"
          initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
        >
          {content}
        </motion.div>
      </AnimatePresence>
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
  server,
}: {
  server: SwitchServer;
}) {
  const store = switchServersStore;
  const serverId = server.id;
  const retrying = store.refreshing.has(serverId);
  const { navigate } = useNavigate();
  // A server this Console runs is not a connection problem: the network
  // between here and it is this machine, or a host whose reachability is
  // modelled separately. Console watches its process, and the status page says
  // what that found.
  const managed = server.managed;

  // Keep probing while this is on screen. Waiting for the user to press
  // something would leave a server that recovered looking down. This only
  // re-checks connectivity, not sign-in options: those keep their once-cached
  // behavior so a real outage does not turn into two doomed round trips on
  // every tick, forever. A single explicit click is a different budget — see
  // the Retry button below, which pays for the full check.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void store.retryConnection(serverId);
    }, UNREACHABLE_RETRY_MS);
    return () => clearInterval(timer);
  }, [serverId, store]);

  return (
    <div className={`${card} flex items-center justify-between gap-3`}>
      <div className="flex items-center gap-2 text-sm">
        <PlugZap className="size-4 text-amber-500" />
        <span className="text-foreground">
          {managed ? `${server.name} isn't answering` : 'Cannot reach the server'}
        </span>
        <span className="text-foreground-muted">
          {retrying
            ? 'Reconnecting…'
            : managed
              ? 'Server status shows what it is doing.'
              : 'Check your connection.'}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {managed && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('managedServer', { serverId })}
          >
            Server status
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={retrying}
          // A full refreshServer, not the lighter retryConnection the timer
          // above uses: a click is one bounded request, not a forever-repeating
          // one, so it can afford to also re-check sign-in options — the one
          // way a persistently broken sign-in-options endpoint gets re-driven.
          onClick={() => void store.refreshServer(serverId)}
        >
          <RefreshCw className={retrying ? 'size-4 animate-spin' : 'size-4'} />
          Retry
        </Button>
      </div>
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
      return homeRedirect();
    }
    // Saved params outlive the server they name: deleting one leaves its id
    // here, and a page restored onto it reads a gateway nothing can resolve.
    // Until the list has been read, an absent server means "not asked yet" —
    // the store revalidates once it knows.
    if (switchServersStore.loaded && !switchServersStore.servers.some((s) => s.id === serverId)) {
      return { ...homeRedirect(), discardParams: true };
    }
    return { ok: true };
  },
} satisfies ViewDefinition<{ serverId: string }>;
