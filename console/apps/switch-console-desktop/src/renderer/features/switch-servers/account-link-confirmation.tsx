import { format } from 'date-fns';
import { Check, Copy } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useModalContext } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { log } from '@renderer/utils/logger';
import type { LinkCode, LinkedIdentity } from '@shared/core/switch-servers/switch-servers';
import { accountHandle, linkRequestFailureText } from './link-accounts-prose';
import { useMyIdentities, useMyPendingIdentities } from './use-my-identities';

/** How often to look for the link having been confirmed. Nothing tells the app
 * when the code is posted, so it asks — for as long as the code is on screen,
 * expired or not: the expiry is read off this machine's clock, and one running
 * fast must not stop the app noticing a code that was posted in time. */
export const LINK_CONFIRMATION_POLL_MS = 3000;

/** How long "Linked" stays on screen before the caller moves on, so the
 * confirmation is seen rather than inferred from the dialog vanishing. */
const CONFIRMED_HOLD_MS = 1200;

/**
 * The link being confirmed.
 *
 * `pending` counts for nothing until the code is posted, and cancelling drops
 * it. `unverified` was made before links had to be confirmed and already
 * counts: cancelling withdraws only the code, and the link stays as it was.
 */
export type AccountLinkTarget = {
  /** The `ExternalUser` row id. */
  identityId: string;
  externalUsername: string;
  kind: 'pending' | 'unverified';
};

/**
 * Show the one-time code that confirms a link, and wait for it to be posted
 * from the account (CHOO-3881).
 *
 * The server keeps no copy of a code, so there is no "show it again": every
 * code shown after the first is a new one, and asking for it retires the last.
 *
 * A pending link can also be cancelled somewhere else — by an admin, on another
 * device, by unlinking — and the screen notices rather than waiting forever.
 * An unverified link cannot be watched that way: the pending list leaves out
 * requests for links that already exist, so its absence there says nothing.
 */
export const AccountLinkConfirmation = observer(function AccountLinkConfirmation({
  workspaceId,
  bridgeId,
  bridgeDisplayName,
  target,
  initialCode,
  onConfirmed,
  onCancelled,
  onStartAgain,
}: {
  workspaceId: string;
  bridgeId: string;
  bridgeDisplayName: string;
  target: AccountLinkTarget;
  /** The code a claim came back with. Null asks for a fresh one on open. */
  initialCode: LinkCode | null;
  onConfirmed: (identity: LinkedIdentity) => void;
  /** After the confirmation is withdrawn: a pending link is gone, an
   * unverified one stays as it was. Either way the code screen is done. */
  onCancelled: () => void;
  /** After a pending link was found cancelled somewhere else, to link again. */
  onStartAgain: () => void;
}) {
  const { setCloseGuard } = useModalContext();
  const [openedAt] = useState(() => Date.now());
  const [shown, setShown] = useState<ShownCode | null>(() =>
    initialCode === null ? null : arrived(initialCode)
  );
  const code = shown?.code ?? null;
  const [expiredCode, setExpiredCode] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const expired = code !== null && expiredCode === code.code;

  const pollMs = gone ? false : LINK_CONFIRMATION_POLL_MS;
  const { identities, refresh } = useMyIdentities(workspaceId, pollMs);
  const { pending, updatedAt: pendingReadAt } = useMyPendingIdentities(
    target.kind === 'pending' ? workspaceId : null,
    pollMs
  );
  const confirmed = identities?.find((i) => i.id === target.identityId && i.verified) ?? null;

  const issueCode = useCallback(async () => {
    setIssuing(true);
    setCloseGuard(true);
    setError(null);
    try {
      const result = await rpc.workspaces.issueIdentityLinkCode({
        workspaceId,
        bridgeId,
        identityId: target.identityId,
      });
      // Either way the lists may have moved: a new code changes when the
      // pending one expires, and a refusal may mean it was confirmed meanwhile.
      refresh();
      if (result.kind !== 'issued') {
        setError(linkRequestFailureText(result));
        return;
      }
      setShown(arrived(result.code));
      setCopied(false);
    } catch (cause) {
      setError(failureText(cause, 'Could not get a new code.'));
    } finally {
      setIssuing(false);
      setCloseGuard(false);
    }
  }, [workspaceId, bridgeId, target.identityId, refresh, setCloseGuard]);

  // Once per mount: a second request would retire the code the first one is
  // about to show.
  const askedOnOpen = useRef(false);
  useEffect(() => {
    if (initialCode !== null || askedOnOpen.current) return;
    askedOnOpen.current = true;
    void issueCode();
  }, [initialCode, issueCode]);

  useEffect(() => {
    if (shown === null || !Number.isFinite(shown.deadline)) return;
    const timer = setTimeout(
      () => setExpiredCode(shown.code.code),
      Math.max(0, shown.deadline - Date.now())
    );
    return () => clearTimeout(timer);
  }, [shown]);

  // Gone from the pending list and not linked either. Posting the code turns
  // the request into a link in one step, but the two lists are read separately,
  // so one read of each can straddle it and show neither. The pending read
  // counts only if it was made since the screen opened; then a read of the
  // linked accounts begun after it settles which happened.
  const absent =
    target.kind === 'pending' &&
    !gone &&
    confirmed === null &&
    identities !== null &&
    pending !== null &&
    pendingReadAt >= openedAt &&
    !pending.some((p) => p.id === target.identityId) &&
    !identities.some((i) => i.id === target.identityId);
  useEffect(() => {
    if (!absent) return;
    let current = true;
    rpc.workspaces.listMyIdentities(workspaceId).then(
      (fresh) => {
        if (!current) return;
        if (fresh.some((i) => i.id === target.identityId)) refresh();
        else setGone(true);
      },
      (error: unknown) => log.warn('Could not check whether a link was cancelled', { error })
    );
    return () => {
      current = false;
    };
  }, [absent, workspaceId, target.identityId, refresh]);

  // Reported once, and only for a confirmation this screen saw happen: one
  // that was already confirmed when it opened is not a moment it witnessed.
  const sawUnconfirmed = useRef(false);
  const reportedConfirmation = useRef(false);
  useEffect(() => {
    if (identities === null) return;
    if (confirmed === null) {
      sawUnconfirmed.current = true;
      return;
    }
    if (!sawUnconfirmed.current || reportedConfirmation.current) return;
    reportedConfirmation.current = true;
    rpc.workspaces
      .reportIdentityConfirmed({
        workspaceId,
        bridgeId,
        identityId: target.identityId,
        kind: target.kind,
      })
      .catch((error: unknown) => log.warn('Could not report a confirmed link', { error }));
  }, [identities, confirmed, workspaceId, bridgeId, target.identityId, target.kind]);

  // Read through a ref so a caller's inline callback does not restart the hold
  // on every render.
  const onConfirmedRef = useRef(onConfirmed);
  useEffect(() => {
    onConfirmedRef.current = onConfirmed;
  });
  const reported = useRef(false);
  useEffect(() => {
    if (confirmed === null || reported.current) return;
    const timer = setTimeout(() => {
      reported.current = true;
      onConfirmedRef.current(confirmed);
    }, CONFIRMED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [confirmed]);

  const cancel = async () => {
    setCancelling(true);
    setCloseGuard(true);
    setError(null);
    try {
      // Never the full unlink: that would also drop an unverified link, which
      // works today and is not what Cancel is about.
      const result = await rpc.workspaces.cancelIdentityLinkRequest({
        workspaceId,
        bridgeId,
        identityId: target.identityId,
      });
      refresh();
      if (result.kind !== 'cancelled') {
        setError(linkRequestFailureText(result));
        return;
      }
      onCancelled();
    } catch (cause) {
      setError(failureText(cause, 'Could not cancel.'));
    } finally {
      setCancelling(false);
      setCloseGuard(false);
    }
  };

  const copy = async () => {
    if (code === null) return;
    try {
      await navigator.clipboard.writeText(code.code);
      setCopied(true);
    } catch {
      setError('Could not copy the code. Select it and copy it by hand.');
    }
  };

  const handle = accountHandle(target.externalUsername);

  if (confirmed !== null) {
    return (
      <p className="flex items-center gap-2 text-sm text-green-600 dark:text-green-500">
        <Check className="size-4 shrink-0" />
        {target.kind === 'pending' ? `Linked to ${handle}.` : `${handle} is confirmed.`}
      </p>
    );
  }

  if (gone) {
    return (
      <div
        className="flex w-full flex-col items-start gap-4"
        data-testid="account-link-confirmation"
      >
        <p className="text-sm text-foreground">
          The link to {handle} was cancelled, so its code no longer works.
        </p>
        <Button size="sm" onClick={onStartAgain}>
          Start again
        </Button>
      </div>
    );
  }

  const busy = issuing || cancelling;
  return (
    <div className="flex w-full flex-col gap-4" data-testid="account-link-confirmation">
      <p className="text-sm text-foreground">
        {target.kind === 'pending'
          ? `To finish linking ${handle}, post this code from that account in ${bridgeDisplayName}.`
          : `Confirm ${handle} is yours by posting this code from that account in ${bridgeDisplayName}. The link keeps working meanwhile.`}
      </p>

      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background-1 px-3 py-2.5">
        {code === null ? (
          <span className="flex items-center gap-2 text-sm text-foreground-muted">
            <Spinner className="size-3.5" />
            Getting a code…
          </span>
        ) : (
          <span
            data-testid="link-code"
            className={`font-mono text-xl tracking-widest select-all ${expired ? 'text-foreground-muted line-through' : 'text-foreground'}`}
          >
            {code.code}
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={code === null || expired}
          onClick={() => void copy()}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      {code !== null && (
        <p className="text-xs text-foreground-muted">
          <InlineCode text={code.instructions} />
        </p>
      )}

      {shown !== null &&
        (expired ? (
          <p className="text-xs text-amber-600 dark:text-amber-500">
            This code has expired. Get a new one to{' '}
            {target.kind === 'pending' ? 'finish linking' : 'confirm the link'}.
          </p>
        ) : (
          <p className="flex items-center gap-2 text-xs text-foreground-muted">
            <Spinner className="size-3" />
            {Number.isFinite(shown.deadline)
              ? `Waiting for the code. It expires at ${format(shown.deadline, 'HH:mm')}.`
              : 'Waiting for the code.'}
          </p>
        ))}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={expired ? 'default' : 'outline'}
          size="sm"
          disabled={busy}
          onClick={() => void issueCode()}
        >
          {issuing ? 'Getting a code…' : 'Get a new code'}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void cancel()}>
          {cancelling
            ? 'Cancelling…'
            : target.kind === 'pending'
              ? 'Cancel link'
              : 'Cancel confirmation'}
        </Button>
      </div>

      {error !== null && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
});

/** A code with when it stops working, on this machine's clock. */
type ShownCode = { code: LinkCode; deadline: number };

/**
 * The deadline is counted from when the code arrived, by the lifetime the
 * server gave it, so a clock here that is minutes out still counts the right
 * minutes — and the time shown agrees with the clock the user is looking at.
 * The server's own `expiresAt` is used only when it sends no lifetime, and may
 * be NaN, which shows no expiry at all rather than a wrong one.
 */
function arrived(code: LinkCode): ShownCode {
  const deadline =
    code.expiresInSeconds !== null
      ? Date.now() + code.expiresInSeconds * 1000
      : Date.parse(code.expiresAt);
  return { code, deadline };
}

/** The server's instructions are a Markdown sentence whose only markup is
 * inline code — the command to post. Unbalanced backticks are shown as typed. */
function InlineCode({ text }: { text: string }) {
  const parts = text.split('`');
  if (parts.length % 2 === 0) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code
            key={i}
            className="rounded bg-background-2 px-1 py-0.5 font-mono text-[11px] text-foreground"
          >
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        )
      )}
    </>
  );
}
