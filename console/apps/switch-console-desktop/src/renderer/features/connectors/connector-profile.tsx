import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { ConnectionIcon } from '@renderer/features/switch-servers/connection-icon';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { ConnectorAgentsSection } from './connector-agents-section';
import { TONE_BADGE, connectorCardState } from './connector-card-state';
import {
  connectedAsLine,
  isYours,
  profileConnectAction,
  signInLabel,
  tokenLifetimeLabel,
  workspaceOffNotice,
} from './connectors-catalog';
import { useReloadConnectors } from './connectors-queries';
import { GitHubAccessSection } from './github-access-section';
import { offersAddAgent } from './grant-agents';
import { useConnectService } from './use-connect-service';

const ACTION_LABEL = {
  connect: 'Connect to Switch',
  reconnect: 'Reconnect',
  replace: 'Replace key',
} as const;

/**
 * One connector, in place of the catalog: who the person is connected as and
 * what they allowed, which of their agents use it, and the way to connect,
 * reconnect or disconnect. When the workspace has it off, a member is told
 * who can switch it on and an admin is offered the switch. Opened right after
 * connecting, the Add agent search under the agents starts open.
 */
export function ConnectorProfile({
  serverId,
  workspaceId,
  connection,
  administers,
  justConnected,
  onBack,
}: {
  serverId: string;
  workspaceId: string;
  connection: ConnectionCatalogEntry;
  administers: boolean;
  /** Set when the profile opens because the service was just connected, with the warning Switch gave. */
  justConnected: { warning: string | null } | null;
  onBack: () => void;
}) {
  const reload = useReloadConnectors(workspaceId);
  const connect = useConnectService(serverId, workspaceId);
  const showDisconnect = useShowModal('disconnectServiceModal');
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(justConnected !== null);
  const [notice, setNotice] = useState(justConnected?.warning ?? null);
  const afterConnected = (warning: string | null) => {
    if (!offersAddAgent(connection)) return;
    setNotice(warning);
    setAdding(true);
  };

  const state = connectorCardState(connection);
  const offNotice = workspaceOffNotice(connection, administers);
  // Whatever the server or workspace says, a connection the person has can be disconnected.
  const hasConnection = isYours(connection);
  const connectedAs = connectedAsLine(connection);
  const action = profileConnectAction(connection);

  const enable = async () => {
    setEnabling(true);
    setError(null);
    try {
      await rpc.workspaces.setWorkspaceService({
        workspaceId,
        service: connection.slug,
        enabled: true,
      });
      await reload();
      if (!hasConnection && connection.connectable)
        connect({ ...connection, workspace_enabled: true }, 'connect', afterConnected);
    } catch (cause) {
      setError(failureText(cause, `Could not switch ${connection.name} on for the workspace.`));
    } finally {
      setEnabling(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={onBack}>
          <ArrowLeft className="size-4" />
          Connectors
        </Button>
        <header className="flex items-start gap-4">
          <ConnectionIcon slug={connection.slug} name={connection.name} size="xl" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-3xl font-semibold tracking-tight text-foreground">
                {connection.name}
              </h1>
              {state.kind !== 'connect' && state.kind !== 'connected' && (
                <Badge variant={TONE_BADGE[state.tone]}>{state.label}</Badge>
              )}
            </div>
            <p className="text-sm text-foreground-muted">{connection.description}</p>
            {connectedAs && <p className="text-sm">{connectedAs}</p>}
            {state.detail && <p className="text-sm text-foreground-muted">{state.detail}</p>}
          </div>
          <div className="flex shrink-0 gap-2">
            {action && (
              <Button
                variant={action === 'replace' ? 'outline' : 'default'}
                disabled={!connection.connectable}
                onClick={() =>
                  connect(connection, action === 'replace' ? 'replace' : 'connect', afterConnected)
                }
              >
                {ACTION_LABEL[action]}
              </Button>
            )}
            {hasConnection && (
              <Button variant="outline" onClick={() => showDisconnect({ workspaceId, connection })}>
                Disconnect
              </Button>
            )}
          </div>
        </header>
      </div>

      {offNotice && (
        <div className="flex items-center gap-3 rounded-lg border border-border p-3">
          <p className="flex-1 text-sm">{offNotice.text}</p>
          {offNotice.canEnable && (
            <Button size="sm" disabled={enabling} onClick={() => void enable()}>
              {enabling && <Spinner />}
              {hasConnection || !connection.connectable
                ? 'Enable for the workspace'
                : 'Enable for the workspace and connect'}
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-foreground">General</h2>
        <div className="grid grid-cols-3 gap-6">
          <Fact label="Category">
            <span className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-sm">
              {connection.category}
            </span>
          </Fact>
          <Fact label="Sign-in">{signInLabel(connection)}</Fact>
          <Fact label="Agent access lasts">{tokenLifetimeLabel(connection)}</Fact>
        </div>
      </section>

      {connection.slug === 'github' && state.kind === 'connected' && (
        <GitHubAccessSection serverId={serverId} workspaceId={workspaceId} />
      )}

      <ConnectorAgentsSection
        serverId={serverId}
        workspaceId={workspaceId}
        connection={connection}
        connected={state.kind === 'connected'}
        adding={adding}
        onAddingChange={setAdding}
        notice={notice}
      />
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-medium tracking-wide text-foreground-muted uppercase">{label}</h3>
      <div className="mt-1.5 text-sm text-foreground">{children}</div>
    </div>
  );
}
