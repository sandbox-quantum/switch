import { format } from 'date-fns';
import { useState } from 'react';
import {
  switchOffConfirmation,
  workspaceSwitchNote,
} from '@renderer/features/connectors/connector-copy';
import { ConnectorTile } from '@renderer/features/connectors/connector-tile';
import {
  useConnectorCatalog,
  useReloadConnectors,
  useWorkspaceServices,
} from '@renderer/features/connectors/connectors-queries';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Alert, AlertAction, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { Switch } from '@renderer/lib/ui/switch';
import type { WorkspaceService } from '@shared/core/switch-servers/connection-catalog';
import { switchStanding, switchTiles } from './workspace-switches';

type Outcome = { warning: string | null; error: string | null };

/**
 * A workspace admin's switch for each service, as tiles like Discover's.
 * Switching one off reaches other people's running sessions, so when anyone
 * is connected or any agent uses it, it asks first, naming both counts. A
 * switch shows what the server says: it never flips before the server has
 * answered, and a failure leaves it as it was, with the reason under it.
 */
export function WorkspaceSwitchesTab({
  workspaceId,
  query,
}: {
  workspaceId: string;
  query: string;
}) {
  const services = useWorkspaceServices(workspaceId);
  const catalog = useConnectorCatalog(workspaceId);
  const reload = useReloadConnectors(workspaceId);
  const confirm = useShowModal('confirmActionModal');
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});

  const change = async (service: WorkspaceService, enabled: boolean) => {
    setPending((now) => new Set(now).add(service.slug));
    setOutcomes((now) => ({ ...now, [service.slug]: { warning: null, error: null } }));
    try {
      const result = await rpc.workspaces.setWorkspaceService({
        workspaceId,
        service: service.slug,
        enabled,
      });
      setOutcomes((now) => ({ ...now, [service.slug]: { warning: result.warning, error: null } }));
      await reload();
    } catch (cause) {
      setOutcomes((now) => ({
        ...now,
        [service.slug]: {
          warning: null,
          error: failureText(
            cause,
            `Could not switch ${service.name} ${enabled ? 'on' : 'off'} for the workspace.`
          ),
        },
      }));
    } finally {
      setPending((now) => {
        const next = new Set(now);
        next.delete(service.slug);
        return next;
      });
    }
  };
  const flip = (service: WorkspaceService, enabled: boolean) => {
    const asked = enabled ? null : switchOffConfirmation(service);
    if (asked)
      confirm({
        title: asked.title,
        description: asked.description,
        confirmLabel: 'Switch off',
        onSuccess: () => void change(service, false),
      });
    else void change(service, enabled);
  };

  if (services.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {failureText(services.error, "Could not load the workspace's services.")}
        </AlertDescription>
        <AlertAction>
          <Button size="sm" variant="outline" onClick={() => void services.refetch()}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  if (services.data === undefined)
    return (
      <p className="flex items-center gap-2 text-sm">
        <Spinner /> Loading the workspace&apos;s services…
      </p>
    );
  if (services.data === null)
    return (
      <p className="text-sm text-foreground-muted">
        This server can&apos;t switch services on or off for a workspace. Every service it offers is
        on.
      </p>
    );

  const tiles = switchTiles(services.data, catalog.data, query);
  if (tiles.length === 0)
    return (
      <p className="text-sm text-foreground-muted">
        {query.trim()
          ? `No service matches “${query.trim()}”.`
          : 'This server offers no services to switch.'}
      </p>
    );
  return (
    <div
      role="group"
      aria-label="Workspace connectors"
      className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3"
    >
      {tiles.map(({ service, category }) => {
        const outcome = outcomes[service.slug];
        const busy = pending.has(service.slug);
        return (
          <ConnectorTile
            key={service.slug}
            slug={service.slug}
            name={service.name}
            inert={false}
            onOpen={null}
            control={
              <>
                {busy && <Spinner />}
                <Switch
                  aria-label={`${service.name} for this workspace`}
                  checked={service.enabled}
                  disabled={busy}
                  onCheckedChange={(on) => flip(service, on)}
                />
              </>
            }
          >
            {category && (
              <span className="mt-1 block text-xs text-foreground-muted">{category}</span>
            )}
            <span className="mt-2 block text-sm text-foreground-muted">
              {switchStanding(service)}
            </span>
            {service.updated_at !== null && (
              <span className="mt-1 block text-xs text-foreground-muted">
                {workspaceSwitchNote(service, (iso) => format(new Date(iso), 'MMM d, yyyy'))}
              </span>
            )}
            {outcome?.warning && (
              <span role="status" className="mt-1 block text-xs text-foreground-warning">
                {outcome.warning}
              </span>
            )}
            {outcome?.error && (
              <span role="alert" className="mt-1 block text-xs text-destructive">
                {outcome.error}
              </span>
            )}
          </ConnectorTile>
        );
      })}
    </div>
  );
}
