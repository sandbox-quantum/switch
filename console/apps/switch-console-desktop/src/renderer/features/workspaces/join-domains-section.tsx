import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';

/**
 * The e-mail domains anyone may join a workspace from, as a member, without an
 * invitation.
 *
 * The one domain on offer is the admin's own: that is the domain their
 * signed-in address proves they belong to, and the server refuses any other.
 * It also refuses a public provider's domain, and the reason is shown in place
 * of the button. A server older than the route leaves the section out.
 */
export function JoinDomainsSection({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ['workspace-join-domains', workspaceId];
  const query = useQuery({
    queryKey,
    queryFn: () => rpc.workspaces.listJoinDomains(workspaceId),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function change(domain: string, action: 'add' | 'remove') {
    setBusy(domain);
    setError(null);
    try {
      if (action === 'add') await rpc.workspaces.addJoinDomain({ workspaceId, domain });
      else await rpc.workspaces.removeJoinDomain({ workspaceId, domain });
      await queryClient.invalidateQueries({ queryKey });
    } catch (cause) {
      setError(
        failureText(
          cause,
          action === 'add'
            ? `Could not open the workspace to ${domain}.`
            : `Could not close ${domain}.`
        )
      );
    } finally {
      setBusy(null);
    }
  }

  if (query.isPending) {
    return (
      <section className="flex items-center gap-2 text-xs text-foreground-muted">
        <Spinner className="size-3" />
        Loading e-mail domains…
      </section>
    );
  }
  if (query.isError) {
    return (
      <section>
        <p role="alert" className="text-xs text-destructive">
          {failureText(query.error, 'Could not load the e-mail domains.')}{' '}
          <button type="button" className="underline" onClick={() => void query.refetch()}>
            Try again
          </button>
        </p>
      </section>
    );
  }
  const data = query.data;
  if (data.kind === 'unsupported') return null;
  const ownOpen = data.domains.includes(data.ownDomain);

  return (
    <section className="flex flex-col gap-2" data-testid="join-domains-section">
      <h3 className="text-sm font-medium">Joining by e-mail domain</h3>
      {data.domains.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {data.domains.map((domain) => (
            <li
              key={domain}
              data-testid="join-domain-row"
              className="flex items-center gap-3 px-3 py-2 text-xs"
            >
              <span className="min-w-0 flex-1 truncate text-foreground">
                Anyone with an @{domain} address can join as a member
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                disabled={busy !== null}
                onClick={() => void change(domain, 'remove')}
              >
                {busy === domain ? 'Removing…' : 'Remove'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!ownOpen &&
        (data.ownDomainRefusal !== null ? (
          <p className="text-xs text-foreground-muted">{data.ownDomainRefusal}.</p>
        ) : (
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 text-xs text-foreground-muted">
              Let anyone with an @{data.ownDomain} address join as a member, without an invitation.
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => void change(data.ownDomain, 'add')}
            >
              {busy === data.ownDomain ? 'Allowing…' : 'Allow'}
            </Button>
          </div>
        ))}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
