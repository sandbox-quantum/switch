import { useCallback, useEffect, useRef, useState } from 'react';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { Spinner } from '@renderer/lib/ui/spinner';
import { WizardFrame } from '@renderer/lib/ui/wizard-frame';
import type { InviteServer } from '@shared/core/switch-servers/switch-cloud';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { parseInviteLink, type InviteLink } from '@shared/core/workspaces/invite-link';

/**
 * Join a workspace from the invite link someone sent, instead of choosing where
 * Switch runs.
 *
 * The link names its server, so the page looks that up rather than asking: a
 * server this install already has, or Switch Cloud, goes straight to signing
 * in. Any other server still has to be connected to, because an invite link
 * carries the dashboard's address and the Console also needs the API's — that
 * form opens with the link's address filled in.
 */
export function InvitePage({
  onBack,
  onResolved,
}: {
  onBack: () => void;
  onResolved: (invite: InviteLink, server: InviteServer) => void;
}) {
  const [text, setText] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (checking) return;
    let invite: InviteLink;
    try {
      invite = parseInviteLink(text);
    } catch (cause) {
      setError(failureText(cause, 'That invite link could not be read.'));
      return;
    }
    setChecking(true);
    setError(null);
    try {
      const server = await switchServersStore.serverForInvite(invite.origin);
      onResolved(invite, server);
    } catch (cause) {
      setError(failureText(cause, `Could not look up the server at ${invite.origin}.`));
      setChecking(false);
    }
  };

  return (
    <WizardFrame
      title="Join with an invite link"
      subtitle="Paste the link from your invitation. You'll sign in to the server it's for, then join the workspace."
      pager={{
        pageName: 'Join with an invite link',
        onBack: checking ? null : onBack,
        onNext: null,
      }}
      footer={
        <>
          <Button variant="outline" onClick={onBack} disabled={checking}>
            Back
          </Button>
          <ConfirmButton onClick={() => void submit()} disabled={checking || text.trim() === ''}>
            {checking ? 'Checking…' : 'Continue'}
          </ConfirmButton>
        </>
      }
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="invite-link">Invite link</FieldLabel>
          <Input
            id="invite-link"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="https://switch.example.com/invite#token=…"
            autoFocus
            disabled={checking}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
          <FieldDescription>
            It was in the invitation e-mail, or whoever invited you sent it.
          </FieldDescription>
          {error && (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {error}
            </p>
          )}
        </Field>
      </FieldGroup>
    </WizardFrame>
  );
}

type Acceptance = { kind: 'accepting' } | { kind: 'failed'; message: string };

/**
 * Accept the held invitation now that there is an account to accept it with.
 *
 * Starts on arrival: the user already said what they wanted by pasting the
 * link, and a page with one button that does the obvious would be a question
 * with one answer. A refusal is shown as the server gave it — revoked, expired,
 * used up, addressed to someone else — because each of those needs a different
 * conversation with whoever sent it, and the user can still go on to the
 * workspaces the account is already in.
 */
export function AcceptInvitePage({
  server,
  invite,
  onAccepted,
  onSkip,
}: {
  server: SwitchServer;
  invite: InviteLink;
  onAccepted: () => void;
  onSkip: () => void;
}) {
  const [state, setState] = useState<Acceptance>({ kind: 'accepting' });
  const started = useRef(false);

  const accept = useCallback(async () => {
    setState({ kind: 'accepting' });
    try {
      const workspace = await workspacesStore.acceptInvitation(server.id, invite.token);
      await workspacesStore.setActive(workspace.id);
      onAccepted();
    } catch (cause) {
      setState({
        kind: 'failed',
        message: failureText(cause, `${server.name} could not accept the invitation.`),
      });
    }
  }, [server, invite, onAccepted]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void accept();
  }, [accept]);

  return (
    <WizardFrame
      title={state.kind === 'failed' ? 'The invitation was not accepted' : 'Joining the workspace'}
      subtitle={
        state.kind === 'failed'
          ? 'Ask whoever invited you for a new link, or go on to the workspaces you are already in.'
          : `Accepting your invitation on ${server.name}.`
      }
      pager={{ pageName: 'Accept invitation', onBack: null, onNext: null }}
      footer={
        state.kind === 'failed' ? (
          <>
            <Button variant="outline" onClick={onSkip}>
              Continue without it
            </Button>
            <ConfirmButton onClick={() => void accept()}>Try again</ConfirmButton>
          </>
        ) : null
      }
    >
      {state.kind === 'failed' ? (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      ) : (
        <div className="flex items-center gap-2 text-sm text-foreground-muted">
          <Spinner className="size-3.5" />
          <span>Accepting…</span>
        </div>
      )}
    </WizardFrame>
  );
}
