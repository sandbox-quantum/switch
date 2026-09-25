import { observer } from 'mobx-react-lite';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { remoteServerStore } from './remote-server-store';
import { activitySentence, describeConsole } from './shared-consoles';

/** How much of the host's activity record the page shows. */
const ACTIVITY_SHOWN = 5;

/**
 * Who uses a shared remote server, and what they last did to it (CHOO-2893).
 *
 * Everyone with access to the host can connect, and they all sign in as the
 * server's one admin account, so the server's own records cannot tell them
 * apart. Each Console records itself on the host instead, and this is where
 * that record is read — including how this Console appears to the others.
 *
 * Shows nothing until the record has been read, and nothing at all for a
 * server nobody has recorded anything on.
 */
export const SharedConsolesSection = observer(function SharedConsolesSection({
  sshHost,
}: {
  sshHost: string;
}) {
  const store = remoteServerStore;
  const register = store.registerFor(sshHost);
  const error = store.registerErrorFor(sshHost);
  if (!register && !error) return null;
  if (register && register.consoles.length === 0 && register.activity.length === 0 && !error) {
    return null;
  }

  return (
    <section className="space-y-3">
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium text-foreground">Consoles using this server</h3>
        <p className="text-xs text-foreground-muted">
          Anyone with access to {sshHost} can connect from their own Switch Console. They all sign
          in as the server’s admin, so each Console records itself on the host — that record is what
          is listed here.
        </p>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {register && register.consoles.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {register.consoles.map((console) => (
            <li
              key={console.consoleId}
              className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
            >
              <span className="min-w-0 truncate text-foreground">
                {describeConsole(console)}
                {console.consoleId === register.self && (
                  <span className="text-foreground-muted"> — this Console</span>
                )}
              </span>
              <span className="shrink-0 text-xs text-foreground-muted">
                {console.appVersion} · seen <RelativeTime value={console.lastSeenAt} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {register && register.activity.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-foreground-muted">Recent activity</p>
          <ul className="space-y-0.5 text-xs text-foreground-muted">
            {register.activity.slice(0, ACTIVITY_SHOWN).map((entry) => (
              <li key={`${entry.at}-${entry.consoleId}-${entry.action}`}>
                {activitySentence(entry, register.self)} · <RelativeTime value={entry.at} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
});
