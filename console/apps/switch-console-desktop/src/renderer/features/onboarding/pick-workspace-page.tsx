import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  invitationSummary,
  InvitedBadge,
  joinableSummary,
  listedInvitations,
  listedJoinable,
  useJoinableWorkspaces,
  usePendingInvitations,
} from '@renderer/features/workspaces/pending-invitations';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { WizardFrame } from '@renderer/lib/ui/wizard-frame';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import type { JoinableWorkspace, PendingInvitation } from '@shared/core/workspaces/invitations';
import type { Workspace } from '@shared/core/workspaces/workspaces';
import { onboardingStore } from './onboarding-store';

/**
 * Which of the server's workspaces the window should be scoped to.
 *
 * The page asks the server rather than reading the list this app already holds:
 * signing in is the first moment the gateway will say what the account is a
 * member of, and an install that has been sitting on the sign-in form is
 * answering from before that.
 *
 * Memberships are offered, and so are invitations addressed to the account's
 * own address, which it accepts here without a link. A server older than the
 * route that lists those leaves the section out rather than showing it empty:
 * it cannot say whether anyone invited you, and an empty "nobody has" would be
 * a claim it never made. The third kind of row, workspaces open to the domain
 * of the account's address, is joined the same way and left out on the same
 * terms.
 */
export const PickWorkspacePage = observer(function PickWorkspacePage({
  server,
  onBack,
  onPicked,
  onCreate,
}: {
  server: SwitchServer;
  onBack: () => void;
  onPicked: () => void;
  onCreate: () => void;
}) {
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['onboarding-workspaces', server.id],
    queryFn: () => rpc.switchServers.resolveWorkspaces(server.id),
  });
  const workspaces = query.data ?? null;
  const invitationsQuery = usePendingInvitations(server.id);
  const invitations = listedInvitations(invitationsQuery.data);
  const joinableQuery = useJoinableWorkspaces(server.id);
  const joinable = listedJoinable(joinableQuery.data);

  const open = useCallback(
    async (workspace: Workspace) => {
      setOpening(workspace.id);
      setOpenError(null);
      try {
        await workspacesStore.setActive(workspace.id);
        onPicked();
      } catch (cause) {
        setOpenError(failureText(cause, `Could not open ${workspace.name}.`));
        setOpening(null);
      }
    },
    [onPicked]
  );

  const accept = useCallback(
    async (invitation: PendingInvitation) => {
      setOpening(invitation.id);
      setOpenError(null);
      try {
        const workspace = await workspacesStore.acceptPendingInvitation(server.id, invitation);
        await workspacesStore.setActive(workspace.id);
        onPicked();
      } catch (cause) {
        setOpenError(failureText(cause, `Could not join ${invitation.workspaceName}.`));
        setOpening(null);
      }
    },
    [server.id, onPicked]
  );

  const join = useCallback(
    async (offer: JoinableWorkspace) => {
      setOpening(offer.tenantId);
      setOpenError(null);
      try {
        const workspace = await workspacesStore.joinByDomain(server.id, offer);
        await workspacesStore.setActive(workspace.id);
        onPicked();
      } catch (cause) {
        setOpenError(failureText(cause, `Could not join ${offer.workspaceName}.`));
        setOpening(null);
      }
    },
    [server.id, onPicked]
  );

  // Once per answer, not once per render: the callbacks are made fresh by the
  // page above, so without the latch a re-render would re-run the choice that
  // is already under way. Every question has to be answered first — an
  // invitation or an open workspace is a choice, so a lone membership beside
  // one is not the only way forward — and a failed check stops the page here,
  // where it is shown, rather than skipping past it on a guess.
  const settled = useRef(false);
  const offers = invitations.length + joinable.length;
  const offersPending = invitationsQuery.isPending || joinableQuery.isPending;
  const offersFailed = invitationsQuery.isError || joinableQuery.isError;
  useEffect(() => {
    if (workspaces === null || offersPending || settled.current) return;
    settled.current = true;
    onboardingStore.resolved(workspaces, offers);
    if (offersFailed || offers > 0) return;
    // A question with one answer is not a question, and with none there is
    // nothing here to answer it with.
    if (workspaces.length === 0) onCreate();
    else if (workspaces.length === 1) void open(workspaces[0]!);
  }, [workspaces, offers, offersPending, offersFailed, open, onCreate]);

  return (
    <WizardFrame
      title="Pick a workspace"
      subtitle={`${pickSubtitle(workspaces?.length ?? 0, offers)} A workspace is where your agents, rooms and teammates live.`}
      /* The chevron below repeats this. It is unlabelled, so it cannot be the
         only way back from a page whose rows all lead forward. Both are held
         shut while a workspace is being opened, since leaving now would land
         the user two pages on when it resolves. */
      footer={
        <Button variant="outline" onClick={onBack} disabled={opening !== null}>
          Back
        </Button>
      }
      pager={{
        pageName: 'Pick a workspace',
        onBack: opening === null ? onBack : null,
        onNext: null,
      }}
    >
      {query.isPending ? (
        <p className="flex items-center gap-2 text-sm text-foreground-muted">
          <Spinner className="size-3.5" />
          Checking which workspaces you’re in…
        </p>
      ) : query.isError ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-destructive">
            {failureText(query.error, `Could not ask ${server.name} which workspaces you’re in.`)}
          </p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="flex w-full flex-col gap-3">
          <ul className="flex flex-col gap-2">
            {(workspaces ?? []).map((workspace) => (
              <WorkspaceRow
                key={workspace.id}
                workspace={workspace}
                opening={opening === workspace.id}
                disabled={opening !== null}
                onOpen={() => void open(workspace)}
              />
            ))}
            {invitations.map((invitation) => (
              <InvitationRow
                key={invitation.id}
                invitation={invitation}
                accepting={opening === invitation.id}
                disabled={opening !== null}
                onAccept={() => void accept(invitation)}
              />
            ))}
            {joinable.map((offer) => (
              <JoinableRow
                key={offer.tenantId}
                offer={offer}
                joining={opening === offer.tenantId}
                disabled={opening !== null}
                onJoin={() => void join(offer)}
              />
            ))}
          </ul>

          {invitationsQuery.isPending && (
            <p className="flex items-center gap-2 text-xs text-foreground-muted">
              <Spinner className="size-3" />
              Checking for invitations to your address…
            </p>
          )}
          {invitationsQuery.isError && (
            <div className="flex items-center gap-3">
              <p className="min-w-0 flex-1 text-sm text-destructive">
                {failureText(
                  invitationsQuery.error,
                  `Could not ask ${server.name} for invitations to your address.`
                )}
              </p>
              <Button variant="outline" size="sm" onClick={() => void invitationsQuery.refetch()}>
                Retry
              </Button>
            </div>
          )}

          {joinableQuery.isError && (
            <div className="flex items-center gap-3">
              <p className="min-w-0 flex-1 text-sm text-destructive">
                {failureText(
                  joinableQuery.error,
                  `Could not ask ${server.name} which workspaces are open to your e-mail domain.`
                )}
              </p>
              <Button variant="outline" size="sm" onClick={() => void joinableQuery.refetch()}>
                Retry
              </Button>
            </div>
          )}

          {openError && <p className="text-sm text-destructive">{openError}</p>}

          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs text-foreground-muted">or start fresh</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <button
            type="button"
            onClick={onCreate}
            disabled={opening !== null}
            className="flex items-center justify-center gap-2 rounded-[10px] border border-dashed border-border px-3.5 py-3 text-sm font-medium text-foreground hover:bg-[var(--sel-soft)] disabled:opacity-50"
          >
            <Plus className="size-4" />
            Create a new workspace
          </button>
        </div>
      )}
    </WizardFrame>
  );
});

function pickSubtitle(memberships: number, offers: number): string {
  if (offers === 0) return 'You’re a member of these.';
  if (memberships === 0) return 'You can join these.';
  return 'You’re a member of these, or can join them.';
}

function JoinableRow({
  offer,
  joining,
  disabled,
  onJoin,
}: {
  offer: JoinableWorkspace;
  joining: boolean;
  disabled: boolean;
  onJoin: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onJoin}
        disabled={disabled}
        data-testid="joinable-workspace-row"
        className="flex w-full items-center gap-3 rounded-[10px] border border-border bg-[var(--surface-2)] px-3.5 py-3 text-left hover:bg-[var(--sel-soft)] disabled:opacity-60"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background-tertiary text-sm font-semibold text-foreground">
          {initialOf(offer.workspaceName)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {offer.workspaceName}
          </span>
          <span className="block truncate text-xs text-foreground-muted">
            {joinableSummary(offer)}
          </span>
        </span>
        {joining ? (
          <Spinner className="size-3.5 shrink-0" />
        ) : (
          <span className="shrink-0 text-sm font-medium text-foreground">Join</span>
        )}
      </button>
    </li>
  );
}

function InvitationRow({
  invitation,
  accepting,
  disabled,
  onAccept,
}: {
  invitation: PendingInvitation;
  accepting: boolean;
  disabled: boolean;
  onAccept: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onAccept}
        disabled={disabled}
        data-testid="pending-invitation-row"
        className="flex w-full items-center gap-3 rounded-[10px] border border-border bg-[var(--surface-2)] px-3.5 py-3 text-left hover:bg-[var(--sel-soft)] disabled:opacity-60"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background-tertiary text-sm font-semibold text-foreground">
          {initialOf(invitation.workspaceName)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {invitation.workspaceName}
          </span>
          <span className="block truncate text-xs text-foreground-muted">
            {invitationSummary(invitation)}
          </span>
        </span>
        <InvitedBadge />
        {accepting ? (
          <Spinner className="size-3.5 shrink-0" />
        ) : (
          <span className="shrink-0 text-sm font-medium text-foreground">Accept</span>
        )}
      </button>
    </li>
  );
}

function WorkspaceRow({
  workspace,
  opening,
  disabled,
  onOpen,
}: {
  workspace: Workspace;
  opening: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        className="flex w-full items-center gap-3 rounded-[10px] border border-border bg-[var(--surface-2)] px-3.5 py-3 text-left hover:bg-[var(--sel-soft)] disabled:opacity-60"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background-tertiary text-sm font-semibold text-foreground">
          {initialOf(workspace.name)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {workspace.name}
        </span>
        {workspace.role && (
          <span className="shrink-0 rounded bg-background-tertiary px-1 py-px text-[10px] font-medium tracking-wide text-foreground-muted uppercase">
            {workspace.role}
          </span>
        )}
        {opening ? (
          <Spinner className="size-3.5 shrink-0" />
        ) : (
          <span className="shrink-0 text-sm text-foreground-muted">Open</span>
        )}
      </button>
    </li>
  );
}

const GRAPHEMES = new Intl.Segmenter();

/** By grapheme, so a name starting with an emoji is not cut in half. */
function initialOf(name: string): string {
  return ([...GRAPHEMES.segment(name)][0]?.segment ?? '?').toUpperCase();
}
