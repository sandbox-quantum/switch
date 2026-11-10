import { observer } from 'mobx-react-lite';
import { type ReactNode } from 'react';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import { type SwitchServer, type SwitchUser } from '@shared/core/switch-servers/switch-servers';

export type SignedInServer = { server: SwitchServer; user: SwitchUser };

/** The server Settings' server pages are about: the one the workspace switcher has on. */
export function settingsServer(): { server: SwitchServer | null; user: SwitchUser | null } {
  const server = switchServersStore.activeServer;
  const status = server ? switchServersStore.statusFor(server.id) : null;
  return { server, user: status?.connected ? (status.user ?? null) : null };
}

/**
 * A page that needs you signed in to the active server, or what to do about
 * it when you are not.
 */
export const OnSignedInServer = observer(function OnSignedInServer({
  children,
}: {
  children: (signedIn: SignedInServer) => ReactNode;
}) {
  const { navigate } = useNavigate();
  const { server, user } = settingsServer();
  if (!server) {
    return <Notice>Add a workspace to see this.</Notice>;
  }
  if (!user) {
    return (
      <Notice
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('server', { serverId: server.id })}
          >
            Sign in
          </Button>
        }
      >
        Sign in to {server.name} to see this.
      </Notice>
    );
  }
  return <>{children({ server, user })}</>;
});

function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-4">
      <p className="text-sm text-foreground-muted">{children}</p>
      {action}
    </div>
  );
}

/** A Settings pane's heading: what it is, and in a line, what it covers. */
export function SettingsPaneHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        {description && <p className="text-sm text-foreground-muted">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}

/** A small uppercase label over a group of rows. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-xs font-medium tracking-wide text-foreground-muted uppercase">
      {children}
    </h2>
  );
}
