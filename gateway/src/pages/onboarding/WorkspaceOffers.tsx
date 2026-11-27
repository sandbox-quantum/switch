import { invitationSummary, joinableSummary } from "@switch-console/chat-ui/model/workspace-offers";
import { Alert } from "@switch-console/chat-ui/primitives/alert";
import { Button } from "@switch-console/chat-ui/primitives/button";
import { Spinner } from "@switch-console/chat-ui/primitives/spinner";
import { useCallback, useEffect, useState } from "react";
import {
  type AddressedInvitation,
  type JoinableTenant,
  acceptMyInvitation,
  fetchJoinableTenants,
  fetchMyInvitations,
  joinTenantByDomain,
} from "../../data/api";

type Answer<T> = { rows: T[]; error: string | null; loading: boolean };

function useAnswer<T>(load: () => Promise<T[]>, failed: string): Answer<T> & { retry: () => void } {
  const [answer, setAnswer] = useState<Answer<T>>({ rows: [], error: null, loading: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setAnswer((was) => ({ ...was, error: null, loading: true }));
    load().then(
      (rows) => {
        if (live) setAnswer({ rows, error: null, loading: false });
      },
      (err: unknown) => {
        if (live) setAnswer({ rows: [], error: err instanceof Error ? err.message : failed, loading: false });
      },
    );
    return () => {
      live = false;
    };
  }, [load, failed, attempt]);
  return { ...answer, retry: () => setAttempt((n) => n + 1) };
}

/** Invitations addressed to the signed-in person, and workspaces open to
 * their email domain, as Console's workspace step offers them. */
export function useWorkspaceOffers() {
  const invitations = useAnswer(fetchMyInvitations, "Could not check for invitations to your address.");
  const joinable = useAnswer(
    fetchJoinableTenants,
    "Could not check which workspaces are open to your email domain.",
  );
  return { invitations, joinable, count: invitations.rows.length + joinable.rows.length };
}

const ROW =
  "flex w-full items-center gap-3 rounded-md border border-border bg-background px-4 py-3 text-left transition-colors hover:bg-background-3 disabled:cursor-not-allowed disabled:opacity-50";

/** The rows to accept or join, each switching into its workspace and then
 * going to `landing`. */
export function WorkspaceOfferRows({
  offers,
  landing,
  disabled,
  onBusy,
}: {
  offers: ReturnType<typeof useWorkspaceOffers>;
  landing: string;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enter = useCallback(
    async (id: string, run: () => Promise<unknown>, failed: string) => {
      setPending(id);
      setError(null);
      onBusy(true);
      try {
        await run();
        window.location.assign(landing);
      } catch (err) {
        setError(err instanceof Error ? err.message : failed);
        setPending(null);
        onBusy(false);
      }
    },
    [landing, onBusy],
  );

  const { invitations, joinable } = offers;
  const busy = disabled || pending !== null;
  return (
    <div className="space-y-2">
      {invitations.rows.map((invitation: AddressedInvitation) => (
        <button
          key={invitation.id}
          type="button"
          className={ROW}
          disabled={busy}
          onClick={() =>
            void enter(
              invitation.id,
              () => acceptMyInvitation(invitation),
              `Could not join ${invitation.tenant_name}.`,
            )
          }
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-foreground">{invitation.tenant_name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {invitationSummary(invitation.invited_by, invitation.role)}
            </span>
          </span>
          {pending === invitation.id ? <Spinner className="size-4" /> : <span className="text-sm">Accept</span>}
        </button>
      ))}
      {joinable.rows.map((offer: JoinableTenant) => (
        <button
          key={offer.tenant_id}
          type="button"
          className={ROW}
          disabled={busy}
          onClick={() =>
            void enter(
              offer.tenant_id,
              () => joinTenantByDomain(offer.tenant_id),
              `Could not join ${offer.tenant_name}.`,
            )
          }
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-foreground">{offer.tenant_name}</span>
            <span className="block truncate text-xs text-muted-foreground">{joinableSummary(offer.domain)}</span>
          </span>
          {pending === offer.tenant_id ? <Spinner className="size-4" /> : <span className="text-sm">Join</span>}
        </button>
      ))}
      {invitations.loading && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          Checking for invitations to your address…
        </p>
      )}
      {[invitations, joinable].map(
        (answer, index) =>
          answer.error !== null && (
            <Alert key={index} variant="destructive" className="flex items-center gap-3">
              <span className="min-w-0 flex-1">{answer.error}</span>
              <Button variant="outline" size="sm" onClick={answer.retry}>
                Retry
              </Button>
            </Alert>
          ),
      )}
      {error && <Alert variant="destructive">{error}</Alert>}
    </div>
  );
}
