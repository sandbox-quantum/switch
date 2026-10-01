import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Check, Copy, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { JoinDomainsSection } from '@renderer/features/workspaces/join-domains-section';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useModalContext, type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { AbsoluteTime } from '@renderer/lib/ui/absolute-time';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Spinner } from '@renderer/lib/ui/spinner';
import {
  invitationStatus,
  type CreatedInvitation,
  type Invitation,
  type InvitationEmailDelivery,
  type InvitationStatus,
  type WorkspaceInvitations,
} from '@shared/core/workspaces/invitations';
import type { WorkspaceRole } from '@shared/core/workspaces/workspaces';

type InvitePeopleModalArgs = {
  /** The workspace to invite to. Its admins and owners are the only ones offered this. */
  workspaceId: string;
};

type Props = BaseModalProps<void> & InvitePeopleModalArgs;

const EXPIRY_CHOICES = [
  { hours: 24, label: '1 day' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' },
] as const;

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  member: 'Member',
  admin: 'Admin',
  owner: 'Owner',
};

const STATUS_LABEL: Record<InvitationStatus, string> = {
  active: 'Active',
  revoked: 'Revoked',
  expired: 'Expired',
  used: 'Used',
};

/**
 * What happened to the e-mail, said beside the link it may have failed to carry.
 *
 * Every case ends on the link, because every case still has one: the
 * invitation stands whether or not the mail went out, and this is the only time
 * it can be shown.
 */
function deliveryNotice(
  delivery: InvitationEmailDelivery,
  email: string | null
): { tone: 'default' | 'warning' | 'destructive'; text: string } {
  switch (delivery) {
    case 'sent':
      return {
        tone: 'default',
        text: `Invitation e-mailed to ${email}. The link below works too; it is shown only once.`,
      };
    case 'not_configured':
      return {
        tone: 'warning',
        text: `No e-mail was sent — this server has no mail set up. Send this link to ${email} yourself; it is shown only once.`,
      };
    case 'failed':
      return {
        tone: 'destructive',
        text: `Sending the e-mail to ${email} failed. The invitation was created: send this link yourself; it is shown only once.`,
      };
    case 'unsupported':
      return email === null
        ? {
            tone: 'default',
            text: 'Send this link to the person you are inviting. It is shown only once.',
          }
        : {
            tone: 'warning',
            text: `No e-mail was sent — this server does not e-mail invitations. Send this link to ${email} yourself; it is shown only once.`,
          };
    case 'not_requested':
      return {
        tone: 'default',
        text: 'Send this link to the person you are inviting. It is shown only once.',
      };
  }
}

/**
 * Invite people to a workspace, and see who has been invited.
 *
 * The same invitations the server's dashboard makes, so one made here can be
 * revoked there and the other way round. Naming an address e-mails the link
 * when the server has mail set up and restricts who can accept it; leaving it
 * empty makes a link for anyone who holds it. Either way the link is shown
 * once, on creation — the server keeps only a hash of it, so nothing can show
 * it again afterwards.
 */
export const InvitePeopleModal = observer(function InvitePeopleModal({
  workspaceId,
  onClose,
}: Props) {
  const { setCloseGuard } = useModalContext();
  const queryClient = useQueryClient();
  const workspace = workspacesStore.byId(workspaceId);
  const queryKey = ['workspace-invitations', workspaceId];

  const query = useQuery({
    queryKey,
    queryFn: () => rpc.workspaces.listInvitations(workspaceId),
  });
  const emailEnabled = query.data?.emailEnabled;

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<WorkspaceRole>('member');
  const [expiresInHours, setExpiresInHours] = useState<number>(168);
  const [uses, setUses] = useState('1');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // Re-read on a timer so an invitation that lapses while the modal is open
  // stops showing as active and stops offering Revoke.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (workspace === null) {
    return (
      <>
        <DialogHeader showCloseButton={false}>
          <DialogTitle>Invite people</DialogTitle>
        </DialogHeader>
        <DialogContentArea className="pt-0">
          <p className="text-sm text-destructive">
            That workspace is no longer held on this computer.
          </p>
        </DialogContentArea>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }

  const roles: WorkspaceRole[] =
    workspace.role === 'owner' ? ['member', 'admin', 'owner'] : ['member', 'admin'];
  const trimmedEmail = email.trim();
  const usesNumber = Number(uses);
  const usesValid = Number.isInteger(usesNumber) && usesNumber > 0;
  const addressed = trimmedEmail !== '';

  const submit = async () => {
    if (submitting || !usesValid) return;
    setSubmitting(true);
    setCloseGuard(true);
    setError(null);
    try {
      const result = await rpc.workspaces.createInvitation({
        workspaceId,
        role,
        email: addressed ? trimmedEmail : null,
        expiresInHours,
        usesRemaining: usesNumber,
      });
      setCreated(result);
      setCopied(false);
      await queryClient.invalidateQueries({ queryKey });
    } catch (cause) {
      setError(failureText(cause, `${workspace.name} could not create the invitation.`));
    } finally {
      setSubmitting(false);
      setCloseGuard(false);
    }
  };

  const copy = async () => {
    if (created === null) return;
    await navigator.clipboard.writeText(created.link);
    setCopied(true);
  };

  const inviteAnother = () => {
    setCreated(null);
    setEmail('');
    setCopied(false);
  };

  const revoke = async (invitation: Invitation) => {
    setRevoking(invitation.id);
    setRevokeError(null);
    try {
      await rpc.workspaces.revokeInvitation({ workspaceId, invitationId: invitation.id });
      await queryClient.invalidateQueries({ queryKey });
    } catch (cause) {
      setRevokeError(failureText(cause, 'Could not revoke the invitation.'));
    } finally {
      setRevoking(null);
    }
  };

  const notice = created ? deliveryNotice(created.emailDelivery, created.invitation.email) : null;

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Invite people to {workspace.name}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="flex flex-col gap-6 pt-0">
        {created !== null && notice !== null ? (
          <div className="flex flex-col gap-3">
            <Alert variant={notice.tone}>
              {notice.tone !== 'default' && <TriangleAlert />}
              <AlertDescription>{notice.text}</AlertDescription>
            </Alert>
            <Field>
              <FieldLabel htmlFor="invite-people-link">Invite link</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="invite-people-link"
                  value={created.link}
                  readOnly
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button variant="outline" onClick={() => void copy()}>
                  {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <FieldDescription>
                They open it in a browser, or paste it into Switch Console when it first starts.
              </FieldDescription>
            </Field>
          </div>
        ) : (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="invite-people-email">E-mail (optional)</FieldLabel>
              <Input
                id="invite-people-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit();
                }}
                placeholder="name@example.com"
                autoFocus
                disabled={submitting}
              />
              <FieldDescription>
                {emailEnabled === false
                  ? 'This server has no e-mail set up, so you’ll get a link to send yourself. '
                  : emailEnabled === null
                    ? 'This server does not e-mail invitations, so you’ll get a link to send yourself. '
                    : emailEnabled === true
                      ? 'We’ll e-mail them the link. '
                      : ''}
                Only someone signed in with this address can accept. Leave it empty for a link
                anyone can use.
              </FieldDescription>
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field>
                <FieldLabel>Role</FieldLabel>
                <Select
                  value={role}
                  onValueChange={(value) => value && setRole(value as WorkspaceRole)}
                  disabled={submitting}
                >
                  <SelectTrigger aria-label="Role">
                    <SelectValue>{ROLE_LABEL[role]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((r) => (
                      <SelectItem key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Expires in</FieldLabel>
                <Select
                  value={String(expiresInHours)}
                  onValueChange={(value) => value && setExpiresInHours(Number(value))}
                  disabled={submitting}
                >
                  <SelectTrigger aria-label="Expires in">
                    <SelectValue>
                      {EXPIRY_CHOICES.find((c) => c.hours === expiresInHours)?.label}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_CHOICES.map((c) => (
                      <SelectItem key={c.hours} value={String(c.hours)}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="invite-people-uses">Uses</FieldLabel>
                <Input
                  id="invite-people-uses"
                  type="number"
                  min={1}
                  value={uses}
                  onChange={(e) => setUses(e.target.value)}
                  disabled={submitting}
                />
              </Field>
            </div>
            {!usesValid && (
              <p className="text-xs text-destructive">Uses must be a whole number, 1 or more.</p>
            )}
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </FieldGroup>
        )}

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Invitations</h3>
          <InvitationList
            query={query}
            now={now}
            revoking={revoking}
            onRevoke={(invitation) => void revoke(invitation)}
          />
          {revokeError && (
            <p role="alert" className="text-xs text-destructive">
              {revokeError}
            </p>
          )}
        </section>

        <JoinDomainsSection workspaceId={workspaceId} />
      </DialogContentArea>
      <DialogFooter>
        {created !== null ? (
          <>
            <Button variant="outline" onClick={inviteAnother}>
              Invite someone else
            </Button>
            <Button onClick={onClose}>Done</Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={submitting}>
              Close
            </Button>
            <ConfirmButton onClick={() => void submit()} disabled={submitting || !usesValid}>
              {submitting && <Spinner className="size-3.5" />}
              {addressed && emailEnabled === true ? 'Send invitation' : 'Create link'}
            </ConfirmButton>
          </>
        )}
      </DialogFooter>
    </>
  );
});

function InvitationList({
  query,
  now,
  revoking,
  onRevoke,
}: {
  query: UseQueryResult<WorkspaceInvitations>;
  now: number;
  revoking: string | null;
  onRevoke: (invitation: Invitation) => void;
}) {
  if (query.isPending) {
    return (
      <div className="flex items-center gap-2 text-xs text-foreground-muted">
        <Spinner className="size-3" />
        Loading invitations…
      </div>
    );
  }
  if (query.isError) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {failureText(query.error, 'Could not load the invitations.')}{' '}
        <button type="button" className="underline" onClick={() => void query.refetch()}>
          Try again
        </button>
      </p>
    );
  }
  const invitations = query.data.invitations;
  if (invitations.length === 0) {
    return <p className="text-xs text-foreground-muted">Nobody has been invited yet.</p>;
  }
  return (
    <ul className="flex max-h-56 flex-col divide-y divide-border overflow-auto rounded-lg border border-border">
      {invitations.map((invitation) => {
        const status = invitationStatus(invitation, now);
        return (
          <li
            key={invitation.id}
            data-testid="invitation-row"
            className="flex items-center gap-3 px-3 py-2 text-xs"
          >
            <span className="min-w-0 flex-1 truncate text-foreground">
              {invitation.email ?? 'Anyone with the link'}
            </span>
            <span className="text-foreground-muted">{ROLE_LABEL[invitation.role]}</span>
            <Badge variant={status === 'active' ? 'outline' : 'secondary'}>
              {STATUS_LABEL[status]}
            </Badge>
            <span className="w-24 text-foreground-muted">
              {status === 'active' ? (
                <>
                  until <AbsoluteTime value={invitation.expiresAt} />
                </>
              ) : null}
            </span>
            <span className="w-16 text-right">
              {status === 'active' && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  disabled={revoking !== null}
                  onClick={() => onRevoke(invitation)}
                >
                  {revoking === invitation.id ? 'Revoking…' : 'Revoke'}
                </Button>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
