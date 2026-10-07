import { useCallback, useEffect, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { ConnectionIcon } from './connection-icon';
import { filterConnections } from './connections-filter';
import { gitHubReconnectMessage, ManagedGitHubStep } from './managed-github-step';

type CardStatus = ConnectionCatalogEntry['status'] | 'checking' | 'reconnect' | 'error';

const STATUS_LABEL: Record<CardStatus, string> = {
  connected: 'Connected',
  not_connected: 'Not connected',
  coming_soon: 'Coming soon',
  checking: 'Checking…',
  reconnect: 'Reconnect required',
  error: 'Error',
};

/**
 * The catalog only records that a GitHub credential is saved, so a saved but
 * expired or revoked authorization is checked against the live status.
 */
export type GitHubLiveStatus =
  | { status: 'checking' | 'connected' | 'not_connected' }
  | { status: 'reconnect' | 'error'; message: string };

export type ConnectionCatalog = {
  connections: ConnectionCatalogEntry[] | null;
  error: string | null;
  github: GitHubLiveStatus | null;
  reload: () => Promise<void>;
};

export function useConnectionCatalog(serverId: string): ConnectionCatalog {
  const [connections, setConnections] = useState<ConnectionCatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [github, setGitHub] = useState<GitHubLiveStatus | null>(null);
  const reload = useCallback(async () => {
    setError(null);
    let entries: ConnectionCatalogEntry[];
    try {
      entries = await rpc.switchServers.getConnectionCatalog(serverId);
    } catch (cause) {
      setError(failureText(cause, 'Could not load connections.'));
      return;
    }
    setConnections(entries);
    if (!entries.some((entry) => entry.slug === 'github' && entry.status === 'connected')) {
      setGitHub(null);
      return;
    }
    setGitHub({ status: 'checking' });
    try {
      setGitHub({ status: (await rpc.switchServers.getGitHubConnection(serverId)).status });
    } catch (cause) {
      const reconnectMessage = gitHubReconnectMessage(cause);
      setGitHub(
        reconnectMessage === null
          ? { status: 'error', message: failureText(cause, 'Could not check GitHub access.') }
          : { status: 'reconnect', message: reconnectMessage }
      );
    }
  }, [serverId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { connections, error, github, reload };
}

function cardStatus(entry: ConnectionCatalogEntry, github: GitHubLiveStatus | null): CardStatus {
  return entry.slug === 'github' && github ? github.status : entry.status;
}

export function ConnectionsGrid({
  catalog,
  query,
  onQueryChange,
  onOpen,
}: {
  catalog: ConnectionCatalog;
  query: string;
  onQueryChange: (query: string) => void;
  onOpen: (slug: string) => void;
}) {
  const { connections, error, github, reload } = catalog;
  const visible = connections ? filterConnections(connections, query) : [];
  return (
    <>
      <DialogHeader>
        <DialogTitle>Connections</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
        <p className="text-sm text-foreground-muted">
          Connect the services your cloud agents can work with.
        </p>
        <SearchInput
          aria-label="Search connections"
          placeholder="Search by name or category"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {connections === null && !error && (
          <p className="flex items-center gap-2 text-sm">
            <Spinner /> Loading connections…
          </p>
        )}
        {error && (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            <Button variant="outline" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        )}
        {connections && (
          <div
            role="group"
            aria-label="Connections"
            className="grid max-h-96 grid-cols-2 gap-2 overflow-auto"
          >
            {visible.map((connection) => {
              const available = connection.enabled && connection.slug === 'github';
              const status = cardStatus(connection, github);
              const problem =
                connection.slug === 'github' && github && 'message' in github
                  ? github.message
                  : null;
              return (
                <button
                  key={connection.slug}
                  type="button"
                  disabled={!available}
                  title={connection.description}
                  onClick={() => onOpen(connection.slug)}
                  className="group flex items-start gap-3 rounded-lg border border-border p-3 text-left enabled:cursor-pointer enabled:hover:bg-background-tertiary-2 disabled:cursor-not-allowed"
                >
                  <ConnectionIcon slug={connection.slug} name={connection.name} />
                  <span className="min-w-0 flex-1 group-disabled:opacity-60">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {connection.name}
                    </span>
                    <span className="block truncate text-xs text-foreground-muted">
                      {connection.category}
                    </span>
                    <Badge
                      className="mt-1.5"
                      variant={
                        status === 'connected' ? 'outline' : problem ? 'destructive' : 'secondary'
                      }
                    >
                      {STATUS_LABEL[status]}
                    </Badge>
                    {problem && (
                      <span role="alert" className="mt-1 block text-xs text-destructive">
                        {problem}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            {visible.length === 0 && (
              <p className="text-sm text-foreground-muted">No connections match “{query}”.</p>
            )}
          </div>
        )}
      </DialogContentArea>
    </>
  );
}

export function ConnectionsStep({
  serverId,
  onBack,
  onSkip,
  onContinue,
}: {
  serverId: string;
  onBack: () => void;
  onSkip: () => void;
  onContinue: () => void;
}) {
  const catalog = useConnectionCatalog(serverId);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  if (open === 'github')
    return (
      <ManagedGitHubStep
        serverId={serverId}
        onBack={() => {
          setOpen(null);
          void catalog.reload();
        }}
        onSkip={onSkip}
        onContinue={onContinue}
      />
    );

  const githubConnected = catalog.github?.status === 'connected';
  return (
    <>
      <ConnectionsGrid catalog={catalog} query={query} onQueryChange={setQuery} onOpen={setOpen} />
      <DialogFooter>
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button variant="ghost" onClick={onSkip}>
          Set up later
        </Button>
        {githubConnected && <Button onClick={onContinue}>Continue to agent</Button>}
      </DialogFooter>
    </>
  );
}
