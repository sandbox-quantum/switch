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
import { ManagedGitHubStep } from './managed-github-step';

const STATUS_LABEL: Record<ConnectionCatalogEntry['status'], string> = {
  connected: 'Connected',
  not_connected: 'Not connected',
  needs_reauthorization: 'Reconnect needed',
  error: 'Connection failed',
  coming_soon: 'Coming soon',
};

export type ConnectionCatalog = {
  connections: ConnectionCatalogEntry[] | null;
  error: string | null;
  reload: () => Promise<void>;
};

export function useConnectionCatalog(serverId: string): ConnectionCatalog {
  const [connections, setConnections] = useState<ConnectionCatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setError(null);
    try {
      setConnections(await rpc.switchServers.getConnectionCatalog(serverId));
    } catch (cause) {
      setError(failureText(cause, 'Could not load connections.'));
    }
  }, [serverId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { connections, error, reload };
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
  const { connections, error, reload } = catalog;
  const visible = connections ? filterConnections(connections, query) : [];
  return (
    <>
      <DialogHeader>
        <DialogTitle>Connections</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
        <p className="text-sm text-foreground-muted">
          Connect the services your agents can work with. Each agent uses a service only once you
          grant it, from the agent's settings.
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
              // GitHub is the one service with a connect step here.
              const available = connection.connectable && connection.slug === 'github';
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
                        connection.status === 'connected'
                          ? 'outline'
                          : connection.status === 'needs_reauthorization' ||
                              connection.status === 'error'
                            ? 'destructive'
                            : 'secondary'
                      }
                    >
                      {STATUS_LABEL[connection.status]}
                    </Badge>
                    {connection.unavailable_reason && (
                      <span className="mt-1 block text-xs text-foreground-muted">
                        {connection.unavailable_reason}
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

  const githubConnected = catalog.connections?.some(
    (connection) => connection.slug === 'github' && connection.status === 'connected'
  );
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
