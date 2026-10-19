import { format } from 'date-fns';
import { ArrowLeft, CircleCheck, CircleX, ExternalLink, MoreHorizontal } from 'lucide-react';
import { Fragment, useState } from 'react';
import { ConnectionIcon } from '@renderer/features/switch-servers/connection-icon';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { openExternalUrl } from '@renderer/lib/open-external';
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
import type { ConnectorApp, ConnectorAppCheck } from '@shared/core/switch-servers/connector-apps';
import {
  type DetailRow,
  STATE_BADGE,
  actionLabel,
  appDetails,
  attention,
  cardState,
  configuredSentence,
  menuActions,
  menuLabel,
  notSetUpSentence,
  primaryAction,
  stateLabel,
  usedBy,
} from './connector-apps';
import { changeBlocked, useConnectorAppDialogs } from './connector-apps-tab';
import { CopyButton } from './copy-button';

/**
 * One connector app on its own page, in front of the tiles: whether it is
 * working, what to do next with one obvious button, and the changes that
 * disconnect people kept apart in the ⋯ menu. Checking it asks the vendor
 * and stores nothing; a failed check is the page's to remember, so its tile
 * shows it too.
 */
export function ConnectorAppProfile({
  serverId,
  app,
  publicUrl,
  checkFailure,
  onCheckFailure,
  onBack,
}: {
  serverId: string;
  app: ConnectorApp;
  publicUrl: string | null;
  checkFailure: string | null;
  onCheckFailure: (message: string | null) => void;
  onBack: () => void;
}) {
  const open = useConnectorAppDialogs(serverId, publicUrl);
  const [checks, setChecks] = useState<ConnectorAppCheck[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = cardState(app, checkFailure);
  const needs = attention(app, checkFailure);
  const primary = primaryAction(app, checkFailure);
  const menu = menuActions(app);
  const blocked = changeBlocked(app, publicUrl);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      const result = await rpc.switchServers.checkConnectorApp({ serverId, service: app.slug });
      setChecks(result.checks);
      onCheckFailure(result.ok ? null : (result.checks.find((c) => !c.ok)?.message ?? null));
    } catch (cause) {
      setError(failureText(cause, `Could not check ${app.name}'s app.`));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={onBack}>
          <ArrowLeft className="size-4" />
          Connector apps
        </Button>
        <header className="flex items-start gap-4">
          <ConnectionIcon slug={app.slug} name={app.name} size="xl" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-3xl font-semibold tracking-tight text-foreground">
                {app.name}
              </h1>
              <Badge variant={STATE_BADGE[state]}>{stateLabel(state)}</Badge>
            </div>
            <p className="text-sm text-foreground-muted">
              {state === 'not_set_up'
                ? notSetUpSentence(app)
                : app.source === 'configuration'
                  ? configuredSentence(app)
                  : usedBy(app)}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            {primary && (
              <Button
                variant={primary === 'check' || primary === 'manage_here' ? 'outline' : 'default'}
                disabled={checking || (blocked && primary !== 'check')}
                onClick={() => (primary === 'check' ? void check() : open(app, primary))}
              >
                {checking && <Spinner />}
                {actionLabel(app, primary)}
              </Button>
            )}
            {menu.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="outline" size="icon" aria-label={`More for ${app.name}`}>
                      <MoreHorizontal className="size-4" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end">
                  {menu.map((action) =>
                    action === 'remove' ? (
                      <Fragment key={action}>
                        {menu.length > 1 && <DropdownMenuSeparator />}
                        <DropdownMenuItem variant="destructive" onClick={() => open(app, action)}>
                          {menuLabel(app, action)}…
                        </DropdownMenuItem>
                      </Fragment>
                    ) : (
                      <DropdownMenuItem
                        key={action}
                        disabled={blocked}
                        onClick={() => open(app, action)}
                      >
                        {menuLabel(app, action)}…
                      </DropdownMenuItem>
                    )
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </header>
      </div>

      {needs && (
        <p
          role="status"
          className="rounded-lg border border-border-warning bg-background-warning p-3 text-sm"
        >
          {needs.sentence}
        </p>
      )}
      {checks && (
        <ul aria-label="What the vendor said" className="space-y-1.5">
          {checks.map((c) => (
            <li key={c.name} className="flex items-start gap-2 text-sm">
              {c.ok ? (
                <CircleCheck
                  aria-label="Passed"
                  className="mt-0.5 size-4 shrink-0 text-foreground-success"
                />
              ) : (
                <CircleX aria-label="Failed" className="mt-0.5 size-4 shrink-0 text-destructive" />
              )}
              {c.message}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {appDetails(app, publicUrl, (iso) => format(new Date(iso), 'MMM d, yyyy')).map((section) => (
        <section key={section.title} className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-foreground">{section.title}</h2>
          <dl className="divide-y divide-border rounded-lg border border-border">
            {section.rows.map((detail) => (
              <DetailItem key={detail.label} detail={detail} />
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

/**
 * One label and its value, the labels in one column so values line up. An
 * identifier is set in a fixed-width face with a copy button; a link opens
 * in the browser.
 */
function DetailItem({ detail }: { detail: DetailRow }) {
  return (
    <div className="grid grid-cols-[10rem_minmax(0,1fr)] items-center gap-4 px-4 py-2.5">
      <dt className="text-sm text-foreground-muted">{detail.label}</dt>
      <dd className="flex min-w-0 items-center gap-1">
        {detail.href ? (
          <button
            type="button"
            className="flex min-w-0 items-center gap-1 text-left text-sm text-foreground underline underline-offset-2"
            onClick={() =>
              void openExternalUrl(detail.href!, `Could not open ${detail.label.toLowerCase()}`)
            }
          >
            <span className="truncate">{detail.value}</span>
            <ExternalLink className="size-3.5 shrink-0" />
          </button>
        ) : detail.code ? (
          <>
            <code className="min-w-0 truncate font-mono text-xs" title={detail.value}>
              {detail.value}
            </code>
            <CopyButton value={detail.value} />
          </>
        ) : (
          <span className="min-w-0 text-sm text-foreground">{detail.value}</span>
        )}
      </dd>
    </div>
  );
}
