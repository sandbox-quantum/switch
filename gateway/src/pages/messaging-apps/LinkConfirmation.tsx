import CheckCircleOutline from "@mui/icons-material/CheckCircleOutline";
import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import OpenInNewOutlined from "@mui/icons-material/OpenInNewOutlined";
import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { SCREEN_READER_ONLY } from "../../components/screenReaderOnly";
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

/** A code, with when it stops working on this machine's clock. */
interface ShownCode {
  code: LinkCode;
  deadline: number;
}

const shown = (code: LinkCode): ShownCode => ({ code, deadline: codeDeadline(code, Date.now()) });

/**
 * Confirm a link from the account itself, the same confirmation Switch Console
 * runs, and wait for it.
 *
 * Switch messages the account three numbers and a "Not me" button. When that
 * message went out, the number to tap leads, and posting the one-time code is
 * the fallback for a message that never arrived. When it could not go out
 * (Teams, a Slack app without the Messages tab, a Telegram user who has never
 * written to the bot), Switch says why and the code is the way.
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
 * turning confirmed, and "Not me" as the link leaving it.
 */
export default function LinkConfirmation({
  app,
  target,
  initialCode,
  onBusy,
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
  onConfirmed: () => void;
  /** After the confirmation is withdrawn: a pending link is gone, an older
   *  one stays as it was. */
  onCancelled: () => void;
  /** After a pending link was found cancelled somewhere else. */
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
  // noticing a code that was posted in time.
  const {
    linked,
    pending,
    pendingReadAt,
    error: watchError,
    refresh,
  } = useMyAccounts(gone || appGone ? null : CONFIRMATION_POLL_MS);
  const [settleError, setSettleError] = useState<string | null>(null);
  const confirmed = linked?.some((i) => i.id === target.identityId && i.verified) ?? false;
  // An older link counts as dropped only once this screen has seen it listed.
  const listed = linked?.some((i) => i.id === target.identityId) ?? false;
  const [sawListed, setSawListed] = useState(false);
  useEffect(() => {
    if (listed) setSawListed(true);
  }, [listed]);

  const issue = useCallback(async () => {
    setIssuing(true);
    onBusy(true);
    setError(null);
    try {
      setCode(shown(await issueLinkCode(app.bridge_id, target.identityId)));
      setCopied(false);
    } catch (e) {
      if (isAppGone(e)) setAppGone(true);
      else setError(e instanceof Error ? e.message : "Could not get a new code.");
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

  // In neither list after a pending read made since the screen opened: a read
  // of the linked accounts begun now settles whether it was confirmed or
  // cancelled. Asked again after every pending read while it looks so, so a
  // settling read that fails is retried rather than left unanswered.
  // Not while this screen's own Cancel is in flight: a read landing between
  // the server dropping the request and its answer would call it cancelled
  // somewhere else.
  const absent =
    !gone &&
    !confirmed &&
    !cancelling &&
    looksCancelled({ target, linked, pending, pendingReadAt, openedAt, sawListed });
  useEffect(() => {
    if (!absent) return;
    let current = true;
    fetchMyIdentities().then(
      (fresh) => {
        if (!current) return;
        setSettleError(null);
        if (fresh.some((i) => i.id === target.identityId)) refresh();
        else setGone(true);
      },
      (e: unknown) => current && setSettleError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      current = false;
    };
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
        // Nothing was waiting. Either the code was posted a moment ago, and
        // the link is now confirmed, or it was cancelled meanwhile or never
        // had a code. Only the second is what Cancel asked for.
        const fresh = await fetchMyIdentities().catch((read: unknown) => {
          setError(read instanceof Error ? read.message : "Could not cancel.");
          return null;
        });
        if (fresh === null) return;
        const nowConfirmed = fresh.some(
          (i) => i.id === target.identityId && (target.kind === "pending" || i.verified),
        );
        if (nowConfirmed) refresh();
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
  const linkedText = target.kind === "pending" ? `Linked to ${handle}.` : `${handle} is confirmed.`;
  const goneText =
    target.kind === "unverified"
      ? `The link to ${handle} was removed. It may have been declined in ${app.display_name}, so it no longer counts.`
      : promptSent
        ? `The link to ${handle} was cancelled. It may have been declined in ${app.display_name}, so its code no longer works.`
        : `The link to ${handle} was cancelled, so its code no longer works.`;
  const appGoneText = `${app.display_name} is no longer connected to this workspace, so this link can't be finished.`;
  // One region, there from the start, whose words change: a status inserted
  // together with its text is often not read out, and "Linked" stays up only
  // a moment before the dialog closes.
  const announcement = confirmed
    ? linkedText
    : appGone
      ? appGoneText
      : gone
        ? goneText
        : code === null
          ? issuing
            ? "Getting a code."
            : ""
          : expired
            ? "This code has expired."
            : promptSent
              ? `Waiting for you to tap ${prompt.number} in the message sent to ${handle}.`
              : `Waiting for the code to be posted from ${handle}.`;
  const live = (
    <Box role="status" aria-live="polite" sx={SCREEN_READER_ONLY}>
      {announcement}
    </Box>
  );

  if (confirmed) {
    return (
      <>
        {live}
        <Stack direction="row" spacing={1} alignItems="center" sx={{ color: "success.main" }}>
          <CheckCircleOutline fontSize="small" />
          <Typography variant="body2" sx={{ color: "inherit", fontWeight: 600 }}>
            {linkedText}
          </Typography>
        </Stack>
      </>
    );
  }

  if (appGone) {
    return (
      <>
        {live}
        <Alert severity="warning">{appGoneText}</Alert>
      </>
    );
  }

  if (gone) {
    return (
      <>
        {live}
        <Stack spacing={2} alignItems="flex-start">
          <Typography variant="body2">{goneText}</Typography>
          <Button variant="contained" onClick={onStartAgain}>
            Start again
          </Button>
        </Stack>
      </>
    );
  }

  const busy = issuing || cancelling;
  const goal = target.kind === "pending" ? "finish linking" : "confirm the link";
  const openUrl = prompt?.link ?? app.home_url;

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
            <CircularProgress size={16} />
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

  const openButton = (variant: "contained" | "outlined") =>
    openUrl && (
      <Button
        variant={variant}
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
    <>
      {live}
      <Stack spacing={2}>
        {promptSent ? (
          <>
            <Typography variant="body2">
              {target.kind === "pending"
                ? `Switch sent ${handle} a message in ${app.display_name}. Tap ${prompt.number} there to finish linking.`
                : `Switch sent ${handle} a message in ${app.display_name}. Tap ${prompt.number} there to confirm the link. The link keeps working meanwhile.`}
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
                Didn&apos;t get the message? Post this from that account instead:
              </Typography>
              {codeBox}
              {instructions}
            </Stack>
          </>
        ) : (
          <>
            {prompt !== null && (
              <Typography variant="body2" color="text.secondary" data-testid="link-prompt-unavailable">
                {prompt.unavailable_reason === null
                  ? `Couldn't message ${handle} directly.`
                  : `Couldn't message ${handle} directly: ${prompt.unavailable_reason}`}
              </Typography>
            )}
            <Typography variant="body2">
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
            <Typography variant="body2" sx={{ color: "warning.main" }}>
              {promptSent
                ? `This message and code have expired. Send again to ${goal}.`
                : `This code has expired. Get a new one to ${goal}.`}
            </Typography>
          ) : (
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={14} />
              <Typography variant="body2" color="text.secondary">
                {promptSent
                  ? `Waiting for confirmation. The code expires at ${timeOfDay(code.deadline)}.`
                  : `Waiting for the code. It expires at ${timeOfDay(code.deadline)}.`}
              </Typography>
            </Stack>
          ))}

        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button
            variant={expired ? "contained" : "outlined"}
            disabled={busy}
            loading={issuing}
            onClick={() => void issue()}
          >
            {promptSent ? "Send again" : "Get a new code"}
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
    </>
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
