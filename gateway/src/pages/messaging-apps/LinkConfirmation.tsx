import CheckCircleOutline from "@mui/icons-material/CheckCircleOutline";
import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import OpenInNewOutlined from "@mui/icons-material/OpenInNewOutlined";
import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type BridgeDetail,
  cancelLinkRequest,
  fetchMyIdentities,
  issueLinkCode,
  type LinkCode,
} from "../../data/api";
import { MONO_SX } from "../../theme/format";
import {
  accountHandle,
  codeDeadline,
  commandsIn,
  type LinkTarget,
  looksCancelled,
} from "./chatAccounts";
import { CONFIRMATION_POLL_MS, useMyAccounts } from "./useMyAccounts";

/** How long "Linked" stays up before the dialog moves on, so the confirmation
 * is seen rather than inferred from the dialog vanishing. */
export const CONFIRMED_HOLD_MS = 1200;

/** A code, with when it arrived and when it stops working, on this machine's
 * clock. */
interface ShownCode {
  code: LinkCode;
  arrivedAt: number;
  deadline: number;
}

const shown = (code: LinkCode): ShownCode => {
  const arrivedAt = Date.now();
  return { code, arrivedAt, deadline: codeDeadline(code, arrivedAt) };
};

/** The text a screen focuses on when it changes, so a keyboard and a screen
 * reader land on what the screen now says rather than at the dialog's top. */
const LEAD_SX = { outline: "none" } as const;

/**
 * Confirm a link from the account itself, the same confirmation Switch Console
 * runs, and wait for it.
 *
 * Switch messages the account three numbers and a "Not me" button. When that
 * message went out, the number to tap leads, and posting the one-time code is
 * the fallback for a message that never arrived. When it could not go out
 * (Teams, a Slack app without the Messages tab, a Telegram user who has never
 * written to the bot, the hourly limit), Switch says why and the code is the
 * way.
 *
 * Switch keeps no copy of a code, so there is no "show it again": every code
 * after the first is a new one, with a new message, and asking retires the
 * last. That is also why one is asked for once per opening, however often
 * React runs the effect: a second request would kill the one on screen.
 *
 * A link can be dropped somewhere else (an admin, another tab, unlinking, or
 * "Not me" or a wrong number in the message), and the screen notices rather
 * than waiting forever. An older link being confirmed is never in the pending
 * list, so it is watched in the linked list: confirming shows as the link
 * turning confirmed, "Not me" as the link leaving it, and a wrong number as
 * its confirmation no longer waiting while the link stays.
 */
export default function LinkConfirmation({
  app,
  target,
  initialCode,
  onBusy,
  onAnnounce,
  onConfirmed,
  onCancelled,
  onStartAgain,
}: {
  app: BridgeDetail;
  target: LinkTarget;
  /** The code a claim came back with; null asks for a fresh one on open. */
  initialCode: LinkCode | null;
  /** Raised while a request is in flight, so the dialog holds its close. */
  onBusy: (busy: boolean) => void;
  /** What a screen reader should hear now, for the dialog's one live region:
   *  one there from the start is read out, one inserted with its text often
   *  is not, and this screen appears in place of the search. */
  onAnnounce: (text: string) => void;
  onConfirmed: () => void;
  /** After the confirmation is withdrawn: a pending link is gone, an older
   *  one stays as it was. */
  onCancelled: () => void;
  /** After a link was found dropped somewhere else, to link again. */
  onStartAgain: () => void;
}) {
  const [openedAt] = useState(() => Date.now());
  const [code, setCode] = useState<ShownCode | null>(() =>
    initialCode === null ? null : shown(initialCode),
  );
  const [now, setNow] = useState(() => Date.now());
  const [issuing, setIssuing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [appGone, setAppGone] = useState(false);
  const expired = code !== null && now >= code.deadline;

  // Watched for as long as the code is up, expired or not: the expiry is read
  // off this machine's clock, and one running fast must not stop the page
  // noticing a confirmation that came in time.
  const {
    linked,
    pending,
    pendingReadAt,
    linkedAskedAt,
    error: watchError,
    refresh,
  } = useMyAccounts(gone || appGone ? null : CONFIRMATION_POLL_MS);
  const [settleError, setSettleError] = useState<string | null>(null);
  const mine = linked?.find((i) => i.id === target.identityId) ?? null;
  const confirmed = mine?.verified ?? false;
  // An older link counts as dropped only once this screen has seen it
  // listed, and its confirmation as cancelled only once a read asked after
  // the current code arrived has seen it waiting: an answer to a question
  // asked before then can say "waiting" about the code it replaced.
  const [sawListed, setSawListed] = useState(false);
  const codeAt = code?.arrivedAt ?? openedAt;
  const readSinceCode = linkedAskedAt >= codeAt;
  const [sawWaitingFor, setSawWaitingFor] = useState<number | null>(null);
  useEffect(() => {
    if (mine !== null) setSawListed(true);
    if (readSinceCode && mine?.awaiting_confirmation) setSawWaitingFor(codeAt);
  }, [mine, readSinceCode, codeAt]);
  const confirmationDropped =
    target.kind === "unverified" &&
    !confirmed &&
    !issuing &&
    readSinceCode &&
    sawWaitingFor === codeAt &&
    mine !== null &&
    !mine.awaiting_confirmation;

  const issue = useCallback(async () => {
    setIssuing(true);
    onBusy(true);
    setError(null);
    try {
      setCode(shown(await issueLinkCode(app.bridge_id, target.identityId)));
      setCopied(false);
    } catch (e) {
      if (isAppGone(e)) setAppGone(true);
      else if (e instanceof ApiError && (e.status === 404 || isUnlinkable(e))) {
        // Nothing left to confirm: the link was cancelled or removed before
        // this screen asked (a row read a while ago), or the account can
        // never be linked and Switch dropped the link. The server's words
        // say which, and the screen offers to start again.
        setError(e.message);
        setGone(true);
      } else setError(e instanceof Error ? e.message : "Could not get a new code.");
    } finally {
      // Either way the lists may have moved: a refusal may mean the link was
      // confirmed or cancelled meanwhile.
      refresh();
      setIssuing(false);
      onBusy(false);
    }
  }, [app.bridge_id, target.identityId, refresh, onBusy]);

  const askedOnOpen = useRef(false);
  useEffect(() => {
    if (initialCode !== null || askedOnOpen.current) return;
    askedOnOpen.current = true;
    void issue();
  }, [initialCode, issue]);

  // A tick a second while a code is counting, for the expiry to land on time.
  useEffect(() => {
    if (code === null || expired) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code, expired]);

  // Dropped somewhere else, by the look of the lists: a read of the linked
  // accounts begun now settles whether it was confirmed or dropped. Asked
  // again after every read while it looks so, so a settling read that fails
  // is retried; never two at once, so a slow one is not thrown away by the
  // next poll. Not while this screen's own Cancel is in flight: a read
  // landing between the server dropping the request and its answer would
  // call it dropped somewhere else.
  const absent =
    !gone &&
    !confirmed &&
    !cancelling &&
    looksCancelled({ target, linked, pending, pendingReadAt, openedAt, sawListed });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const settling = useRef(false);
  useEffect(() => {
    if (!absent || settling.current) return;
    settling.current = true;
    fetchMyIdentities()
      .then(
        (fresh) => {
          if (!mounted.current) return;
          setSettleError(null);
          if (fresh.some((i) => i.id === target.identityId)) refresh();
          else setGone(true);
        },
        (e: unknown) => {
          if (mounted.current) setSettleError(e instanceof Error ? e.message : String(e));
        },
      )
      .finally(() => {
        settling.current = false;
      });
  }, [absent, pendingReadAt, target.identityId, refresh]);

  // Read through a ref so a caller's inline callback does not restart the
  // hold on every render.
  const onConfirmedRef = useRef(onConfirmed);
  useEffect(() => {
    onConfirmedRef.current = onConfirmed;
  });
  useEffect(() => {
    if (!confirmed) return;
    const timer = setTimeout(() => onConfirmedRef.current(), CONFIRMED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [confirmed]);

  const cancel = async () => {
    setCancelling(true);
    onBusy(true);
    setError(null);
    try {
      // Never the full unlink: that would also drop an older link, which
      // counts today and is not what Cancel is about.
      await cancelLinkRequest(app.bridge_id, target.identityId);
      onCancelled();
    } catch (e) {
      if (isAppGone(e)) setAppGone(true);
      else if (e instanceof ApiError && e.status === 404) {
        // Nothing was waiting. The link may have just been confirmed, or
        // dropped from the message ("Not me" removes an older link), or the
        // request cancelled meanwhile. Only the last is what Cancel asked for.
        const fresh = await fetchMyIdentities().catch((read: unknown) => {
          setError(read instanceof Error ? read.message : "Could not cancel.");
          return null;
        });
        if (fresh === null) return;
        const current = fresh.find((i) => i.id === target.identityId) ?? null;
        if (current !== null && (target.kind === "pending" || current.verified)) refresh();
        else if (current === null && target.kind === "unverified") setGone(true);
        else onCancelled();
      } else {
        setError(e instanceof Error ? e.message : "Could not cancel.");
        refresh();
      }
    } finally {
      setCancelling(false);
      onBusy(false);
    }
  };

  const handle = accountHandle(target.username);
  // The whole command, since that is what gets posted: the code alone would
  // be retyped around.
  const command = code === null ? null : (commandsIn(code.code.instructions)[0] ?? code.code.code);

  const copy = async () => {
    if (command === null) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setError("Could not copy. Select the command and copy it by hand.");
    }
  };

  // Only the latest message counts: a new code retires the buttons on the
  // one before.
  const prompt = code?.code.prompt ?? null;
  const promptSent = prompt !== null && prompt.sent;
  const unsentReason =
    prompt !== null && !prompt.sent
      ? prompt.unavailable_reason === null
        ? `Couldn't message ${handle} directly.`
        : `Couldn't message ${handle} directly: ${prompt.unavailable_reason}`
      : null;
  const fromMessage = promptSent ? `, perhaps from the message in ${app.display_name}` : "";
  const linkedText = target.kind === "pending" ? `Linked to ${handle}.` : `${handle} is confirmed.`;
  const goneText =
    target.kind === "unverified"
      ? `The link to ${handle} was removed${fromMessage}, so it no longer counts.`
      : `The link to ${handle} was cancelled${fromMessage}, so its code no longer works.`;
  const droppedText = promptSent
    ? `The confirmation was cancelled, perhaps by tapping a different number in the message in ${app.display_name}. The link to ${handle} still works. Send again to confirm it.`
    : `The confirmation was cancelled. The link to ${handle} still works. Get a new code to confirm it.`;
  const appGoneText = `${app.display_name} is no longer connected to this workspace, so this link can't be finished.`;
  const announcement = confirmed
    ? linkedText
    : appGone
      ? appGoneText
      : gone
        ? (error ?? goneText)
        : confirmationDropped
          ? droppedText
          : code === null
            ? issuing
              ? "Getting a code."
              : ""
            : expired
              ? "This code has expired."
              : promptSent
                ? `We sent ${handle} a message in ${app.display_name}. Tap ${prompt.number} there.`
                : `${unsentReason === null ? "" : `${unsentReason} `}Waiting for the code to be posted from ${handle}.`;
  useEffect(() => {
    onAnnounce(announcement);
  }, [announcement, onAnnounce]);

  // Focus follows what the screen now says. A button that started a request
  // is disabled while it runs, which drops focus to the dialog's top; and a
  // new screen (linked, dropped) replaces the control that was focused.
  const view = confirmed
    ? "confirmed"
    : appGone
      ? "app-gone"
      : gone
        ? "gone"
        : confirmationDropped
          ? "dropped"
          : `code:${code?.code.code ?? ""}`;
  const leadElement = useRef<HTMLElement | null>(null);
  const lead = useCallback((element: HTMLElement | null) => {
    leadElement.current = element;
  }, []);
  useEffect(() => {
    leadElement.current?.focus();
  }, [view]);

  if (confirmed) {
    return (
      <Stack direction="row" spacing={1} alignItems="center" sx={{ color: "var(--sw-success-text)" }}>
        <CheckCircleOutline fontSize="small" />
        <Typography ref={lead} tabIndex={-1} variant="body2" sx={{ ...LEAD_SX, color: "inherit", fontWeight: 600 }}>
          {linkedText}
        </Typography>
      </Stack>
    );
  }

  if (appGone) {
    return (
      <Alert ref={lead} tabIndex={-1} severity="warning" sx={LEAD_SX}>
        {appGoneText}
      </Alert>
    );
  }

  if (gone) {
    return (
      <Stack spacing={2} alignItems="flex-start">
        {/* The server's words when it said why (an account nobody can link,
            a link removed meanwhile); the screen's guess when it did not. */}
        <Typography ref={lead} tabIndex={-1} variant="body2" sx={{ ...LEAD_SX, overflowWrap: "anywhere" }}>
          {error ?? goneText}
        </Typography>
        <Button variant="contained" onClick={onStartAgain}>
          Start again
        </Button>
      </Stack>
    );
  }

  const busy = issuing || cancelling;
  const goal = target.kind === "pending" ? "finish linking" : "confirm the link";
  const openUrl = prompt?.link ?? app.home_url;
  const resend = promptSent ? "Send again" : "Get a new code";

  if (confirmationDropped) {
    return (
      <Stack spacing={2} alignItems="flex-start">
        <Typography ref={lead} tabIndex={-1} variant="body2" sx={LEAD_SX}>
          {droppedText}
        </Typography>
        <Button variant="contained" loading={issuing} onClick={() => void issue()}>
          {resend}
        </Button>
        {error !== null && (
          <Alert severity="error" sx={{ overflowWrap: "anywhere" }}>
            {error}
          </Alert>
        )}
      </Stack>
    );
  }

  const codeBox = (
    <Stack
      direction="row"
      alignItems="center"
      justifyContent="space-between"
      spacing={2}
      sx={{ px: 2, py: 1.5, border: "1px solid var(--sw-border)", borderRadius: "12px", bgcolor: "var(--sw-muted)" }}
    >
      {code === null ? (
        issuing ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={16} aria-label="Getting a code" />
            <Typography variant="body2" color="text.secondary">
              Getting a code…
            </Typography>
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No code yet.
          </Typography>
        )
      ) : (
        <Typography
          data-testid="link-code"
          sx={{
            ...MONO_SX,
            fontSize: promptSent ? "1rem" : "1.25rem",
            letterSpacing: "0.15em",
            userSelect: "all",
            ...(expired && { color: "text.disabled", textDecoration: "line-through" }),
          }}
        >
          {code.code.code}
        </Typography>
      )}
      <Button
        variant="outlined"
        size="small"
        startIcon={<ContentCopyOutlined fontSize="small" />}
        disabled={command === null || expired}
        onClick={() => void copy()}
        sx={{ flexShrink: 0 }}
      >
        {copied ? "Copied" : "Copy command"}
      </Button>
    </Stack>
  );

  const instructions = code !== null && (
    <Typography variant="body2" color="text.secondary">
      <InlineCode text={code.code.instructions} />
    </Typography>
  );

  // Once the message has expired its buttons no longer work, so opening it
  // steps back for the resend.
  const openButton = (emphasis: "contained" | "outlined") =>
    openUrl && (
      <Button
        variant={expired ? "outlined" : emphasis}
        startIcon={<OpenInNewOutlined fontSize="small" />}
        href={openUrl}
        target="_blank"
        rel="noreferrer noopener"
        sx={{ alignSelf: "flex-start" }}
      >
        Open in {app.display_name}
      </Button>
    );

  return (
    <Stack spacing={2}>
      {promptSent ? (
        <>
          <Typography ref={lead} tabIndex={-1} variant="body2" sx={LEAD_SX}>
            {target.kind === "pending"
              ? `We sent ${handle} a message in ${app.display_name}. Tap ${prompt.number} there to finish linking.`
              : `We sent ${handle} a message in ${app.display_name}. Tap ${prompt.number} there to confirm the link. The link keeps working meanwhile.`}
          </Typography>
          <Box
            sx={{
              py: 2,
              textAlign: "center",
              border: "1px solid var(--sw-border)",
              borderRadius: "12px",
              bgcolor: "var(--sw-muted)",
            }}
          >
            <Typography
              data-testid="link-prompt-number"
              aria-hidden
              sx={{
                fontSize: "2.5rem",
                fontWeight: 600,
                lineHeight: 1.2,
                ...(expired && { color: "text.disabled", textDecoration: "line-through" }),
              }}
            >
              {prompt.number}
            </Typography>
          </Box>
          {openButton("contained")}
          <Stack spacing={1}>
            <Typography variant="body2" color="text.secondary">
              Didn&apos;t get it? Post this code from that account instead:
            </Typography>
            {codeBox}
            {instructions}
          </Stack>
        </>
      ) : (
        <>
          {unsentReason !== null && (
            <Typography variant="body2" color="text.secondary" data-testid="link-prompt-unavailable">
              {unsentReason}
            </Typography>
          )}
          <Typography ref={lead} tabIndex={-1} variant="body2" sx={LEAD_SX}>
            {target.kind === "pending"
              ? `To finish linking ${handle}, post this from that account in ${app.display_name}.`
              : `Confirm ${handle} is yours by posting this from that account in ${app.display_name}. The link keeps working meanwhile.`}
          </Typography>
          {codeBox}
          {instructions}
        </>
      )}

      {code !== null &&
        (expired ? (
          <Alert severity="warning">
            This code has expired. {promptSent ? "Send again" : "Get a new one"} to {goal}.
          </Alert>
        ) : (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={14} aria-label="Waiting" />
            <Typography variant="body2" color="text.secondary">
              {promptSent
                ? `Waiting for confirmation. The code expires at ${timeOfDay(code.deadline)}.`
                : `Waiting for the code. It expires at ${timeOfDay(code.deadline)}.`}
            </Typography>
          </Stack>
        ))}

      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button variant={expired ? "contained" : "outlined"} disabled={busy} loading={issuing} onClick={() => void issue()}>
          {resend}
        </Button>
        {!promptSent && openButton("outlined")}
        <Button color="inherit" disabled={busy} loading={cancelling} onClick={() => void cancel()}>
          {target.kind === "pending" ? "Cancel link" : "Cancel confirmation"}
        </Button>
      </Stack>

      {error !== null && (
        <Alert severity="error" sx={{ overflowWrap: "anywhere" }}>
          {error}
        </Alert>
      )}

      {/* Without these the screen would go on saying it is waiting while it
          can no longer tell whether the link was confirmed. */}
      {(watchError ?? settleError) !== null && (
        <Alert severity="warning" sx={{ overflowWrap: "anywhere" }}>
          Can&apos;t check whether the link was confirmed: {watchError ?? settleError}
        </Alert>
      )}
    </Stack>
  );
}

/** A refusal saying the app, or the account's record with it, is gone: the
 * app was deleted while the screen was open. Switch words both as a 404 with
 * these details. */
function isAppGone(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    e.status === 404 &&
    (e.detail === "Bridge not found" || e.detail === "Identity not found")
  );
}

/** A refusal saying the account can never be linked (a bot, a webhook's
 * stand-in), on which Switch drops any older link to it. */
function isUnlinkable(e: ApiError): boolean {
  return e.status === 409 && e.message.startsWith("This account cannot be linked to anyone.");
}

function timeOfDay(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** The instructions are a Markdown sentence whose only markup is inline code,
 * the command to post. Unbalanced backticks are shown as typed. */
function InlineCode({ text }: { text: string }) {
  const parts = text.split("`");
  if (parts.length % 2 === 0) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Box
            key={i}
            component="code"
            sx={{ ...MONO_SX, px: 0.5, py: 0.25, borderRadius: "4px", bgcolor: "var(--sw-muted)", color: "text.primary" }}
          >
            {part}
          </Box>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
