import CloseOutlined from "@mui/icons-material/CloseOutlined";
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton } from "@mui/material";
import { useCallback, useRef, useState } from "react";
import { SCREEN_READER_ONLY } from "../../components/screenReaderOnly";
import type { BridgeDetail, LinkCode } from "../../data/api";
import { platformLabel } from "../../theme/format";
import AccountSearch from "./AccountSearch";
import { accountHandle, type LinkTarget } from "./chatAccounts";
import LinkConfirmation from "./LinkConfirmation";

/** What the dialog is for: finding your account, or confirming a link that
 * waits on a code. */
export type LinkDialogOpen =
  | { app: BridgeDetail; confirm: null }
  | { app: BridgeDetail; confirm: LinkTarget };

/** How the dialog ended, when it ended in a link that counts: what the page
 * says once the dialog has gone. */
export interface LinkOutcome {
  app: BridgeDetail;
  handle: string;
  /** A new link, or an older one now confirmed. */
  kind: "linked" | "confirmed";
}

/**
 * Link the signed-in person to their own account in a messaging app, on the
 * web, with the same confirmation Switch Console runs: say which account is
 * you, then confirm from it, by tapping the number Switch messages it or by
 * posting a one-time code.
 *
 * Opened on a link already waiting (Finish linking, Confirm), it goes straight
 * to confirming, and cancelling there closes it. Opened to link, cancelling
 * goes back to the search, since the likeliest reason is having picked the
 * wrong account.
 *
 * Closing is not cancelling: a waiting link stays, and its row offers a new
 * code for it.
 */
export default function LinkAccountDialog({
  open,
  currentUserId,
  onClose,
}: {
  open: LinkDialogOpen | null;
  currentUserId: string | null;
  /** Called whenever the dialog closes, with the link it made if it made
   *  one; the caller re-reads the accounts either way. */
  onClose: (outcome: LinkOutcome | null) => void;
}) {
  // Requests in flight, counted rather than flagged: a request from a screen
  // already left behind must not clear the hold for one still running.
  // Closing mid-request would abandon a claim or a code half-way, so the
  // flow's buttons are disabled meanwhile and this holds Escape and the
  // backdrop too.
  const [inFlight, setInFlight] = useState(0);
  const onBusy = useCallback((busy: boolean) => setInFlight((n) => n + (busy ? 1 : -1)), []);
  const busy = inFlight > 0;
  // Kept through the closing transition, so the dialog fades out with its
  // contents rather than as an empty box.
  const last = useRef(open);
  if (open !== null) last.current = open;
  const showing = last.current;

  return (
    <Dialog
      open={open !== null}
      onClose={() => {
        if (!busy) onClose(null);
      }}
      maxWidth="sm"
      fullWidth
      slotProps={{ paper: { sx: { borderRadius: "16px" } } }}
    >
      {/* Remounted per opening, so a new app or target starts clean. */}
      {showing !== null && (
        <LinkAccountFlow
          key={`${showing.app.bridge_id}:${showing.confirm?.identityId ?? ""}`}
          open={showing}
          currentUserId={currentUserId}
          busy={busy}
          onBusy={onBusy}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

function LinkAccountFlow({
  open,
  currentUserId,
  busy,
  onBusy,
  onClose,
}: {
  open: LinkDialogOpen;
  currentUserId: string | null;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onClose: (outcome: LinkOutcome | null) => void;
}) {
  const { app } = open;
  const [waiting, setWaiting] = useState<{ target: LinkTarget; code: LinkCode | null } | null>(
    open.confirm === null ? null : { target: open.confirm, code: null },
  );
  // One live region for the whole dialog, there from its start, whose words
  // the screens change: a region inserted with its text is often not read
  // out, and the confirmation replaces the search in place.
  const [announcement, setAnnouncement] = useState("");
  const platform = platformLabel(app.bridge_type);

  return (
    <>
      <Box role="status" aria-live="polite" sx={SCREEN_READER_ONLY}>
        {announcement}
      </Box>
      <DialogTitle sx={{ fontSize: "1.0625rem", fontWeight: 600, pt: 3, pr: 8 }}>
        {waiting === null ? `Link your ${platform} account` : `Confirm your ${platform} account`}
      </DialogTitle>
      <IconButton
        aria-label="Close"
        onClick={() => onClose(null)}
        disabled={busy}
        sx={{ position: "absolute", top: 16, right: 16, width: 36, height: 36 }}
      >
        <CloseOutlined sx={{ fontSize: 18 }} />
      </IconButton>
      <DialogContent sx={{ pb: 3 }}>
        {waiting === null ? (
          <AccountSearch
            app={app}
            currentUserId={currentUserId}
            onBusy={onBusy}
            onAnnounce={setAnnouncement}
            onLinked={(username) => onClose({ app, handle: accountHandle(username), kind: "linked" })}
            onConfirm={(target, code) => setWaiting({ target, code })}
          />
        ) : (
          <LinkConfirmation
            key={waiting.target.identityId}
            app={app}
            target={waiting.target}
            initialCode={waiting.code}
            onBusy={onBusy}
            onAnnounce={setAnnouncement}
            onConfirmed={() =>
              onClose({
                app,
                handle: accountHandle(waiting.target.username),
                kind: waiting.target.kind === "pending" ? "linked" : "confirmed",
              })
            }
            onCancelled={() => (open.confirm === null ? setWaiting(null) : onClose(null))}
            onStartAgain={() => setWaiting(null)}
          />
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, borderTop: "1px solid var(--sw-border)" }}>
        <Button variant="outlined" onClick={() => onClose(null)} disabled={busy}>
          Close
        </Button>
      </DialogActions>
    </>
  );
}
