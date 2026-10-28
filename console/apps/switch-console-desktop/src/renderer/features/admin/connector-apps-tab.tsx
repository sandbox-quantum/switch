import { ConnectorTile } from '@renderer/features/connectors/connector-tile';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Alert, AlertAction, AlertDescription } from '@renderer/lib/ui/alert';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import type { ConnectorApp, ConnectorApps } from '@shared/core/switch-servers/connector-apps';
import {
  type CardAction,
  type MenuAction,
  PUBLIC_URL_BANNER,
  STATE_BADGE,
  actionLabel,
  cardOrder,
  cardState,
  changeBlocked,
  missingPublicUrl,
  stateLabel,
  tileAction,
  tileStanding,
} from './connector-apps';

/**
 * Opens the dialog for an app's action, and says what it did once it is
 * done. Shared by the tiles and the profile, so a fix does the same thing
 * from either. A save checks the app, so it ends on the app's page, where
 * what the vendor said shows.
 */
export function useConnectorAppDialogs(serverId: string, publicUrl: string | null) {
  const showSetup = useShowModal('connectorAppSetupModal');
  const showSecret = useShowModal('connectorAppSecretModal');
  const showRemove = useShowModal('connectorAppRemoveModal');
  const showMove = useShowModal('connectorAppMoveModal');
  const { navigate } = useNavigate();
  const { toast } = useToast();
  const done = (message: string) => toast({ title: message });
  return (app: ConnectorApp, action: Exclude<CardAction, 'check'> | MenuAction) => {
    const base = { serverId, app, onSuccess: done };
    const saved = {
      ...base,
      onSuccess: (message: string) => {
        done(message);
        navigate('admin', { serverId, section: 'apps', app: app.slug });
      },
    };
    switch (action) {
      case 'set_up':
      case 'enter_again':
        return showSetup({ ...saved, publicUrl, mode: action });
      case 'switch_app':
        return showSetup({ ...saved, publicUrl, mode: 'switch' });
      case 'update_secret':
        return showSecret(saved);
      case 'remove':
        return showRemove(base);
      case 'manage_here':
        return showMove(base);
    }
  };
}

/**
 * The server operator's connector apps, as tiles like Discover's: the ones
 * that need attention first, then those not set up, then those working. A
 * tile opens the app's profile; the button beside its badge is only ever
 * the one thing that needs doing.
 */
export function ConnectorAppsTab({
  serverId,
  apps,
  catalog,
  query,
  checkFailures,
  onOpen,
}: {
  serverId: string;
  apps: {
    data: ConnectorApps | null | undefined;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
  };
  catalog: ConnectionCatalogEntry[] | undefined;
  query: string;
  checkFailures: Record<string, string>;
  onOpen: (slug: string) => void;
}) {
  const publicUrl = apps.data?.public_url ?? null;
  const open = useConnectorAppDialogs(serverId, publicUrl);

  if (apps.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>{failureText(apps.error, 'Could not load the apps.')}</AlertDescription>
        <AlertAction>
          <Button size="sm" variant="outline" onClick={() => void apps.refetch()}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  if (apps.data === undefined)
    return (
      <p className="flex items-center gap-2 text-sm">
        <Spinner /> Loading the apps…
      </p>
    );
  if (apps.data === null)
    return (
      <p className="text-sm text-foreground-muted">This server has no connector apps to set up.</p>
    );

  const categories = new Map(catalog?.map((entry) => [entry.slug, entry.category]));
  const needle = query.trim().toLocaleLowerCase();
  const shown = cardOrder(apps.data.apps, checkFailures).filter(
    (app) =>
      !needle ||
      [app.name, categories.get(app.slug) ?? ''].some((text) =>
        text.toLocaleLowerCase().includes(needle)
      )
  );
  return (
    <div className="space-y-3">
      {missingPublicUrl(apps.data.apps, publicUrl) && (
        <Alert>
          <AlertDescription>{PUBLIC_URL_BANNER}</AlertDescription>
        </Alert>
      )}
      {shown.length === 0 ? (
        <p className="text-sm text-foreground-muted">
          {needle ? `No app matches “${query.trim()}”.` : 'This server has no apps to set up.'}
        </p>
      ) : (
        <div
          role="group"
          aria-label="Connector apps"
          className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3"
        >
          {shown.map((app) => {
            const failure = checkFailures[app.slug] ?? null;
            const state = cardState(app, failure);
            const action = tileAction(app, failure);
            return (
              <ConnectorTile
                key={app.slug}
                slug={app.slug}
                name={app.name}
                inert={false}
                onOpen={() => onOpen(app.slug)}
                control={
                  action && (
                    <Button
                      size="sm"
                      variant={action === 'set_up' ? 'default' : 'outline'}
                      aria-label={actionLabel(app, action)}
                      disabled={changeBlocked(app, publicUrl)}
                      onClick={() => open(app, action)}
                    >
                      {action === 'set_up' ? 'Set up' : actionLabel(app, action)}
                    </Button>
                  )
                }
              >
                <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
                  {categories.get(app.slug)}
                  <Badge variant={STATE_BADGE[state]}>{stateLabel(state)}</Badge>
                </span>
                <span className="mt-2 block text-sm text-foreground-muted">
                  {tileStanding(app, failure)}
                </span>
              </ConnectorTile>
            );
          })}
        </div>
      )}
    </div>
  );
}
