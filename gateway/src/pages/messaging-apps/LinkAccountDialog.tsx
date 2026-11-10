import CloseOutlined from "@mui/icons-material/CloseOutlined";
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton } from "@mui/material";
import { useState } from "react";
import type { BridgeDetail, LinkCode } from "../../data/api";
import { platformLabel } from "../../theme/format";
import AccountSearch from "./AccountSearch";
import type { LinkTarget } from "./chatAccounts";
import LinkConfirmation from "./LinkConfirmation";

/** What the dialog is for: finding your account, or confirming a link that
 * waits on a code. */
export type LinkDialogOpen =
  | { app: BridgeDetail; confirm: null }
  | { app: BridgeDetail; confirm: LinkTarget };

/**
 * Link the signed-in person to their own account in a messaging app, on the
 * web, with the same confirmation Switch Console runs: say which account is
 * you, then post a one-time code from it.
 *
 * Opened on a link already waiting (Show code, Confirm), it goes straight to
 * the code, and cancelling there closes it. Opened to link, cancelling the
 * code goes back to the search, since the likeliest reason is having picked
 * the wrong account.
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
  /** Called whenever the dialog closes, linked or not; the caller re-reads
   *  the accounts either way. */
  onClose: () => void;
}) {
  // Held while a request is in flight: closing then would abandon a claim or
  // a code half-way. The flow's own buttons are disabled meanwhile; this
  // holds Escape and the backdrop too.
  const [busy, setBusy] = useState(false);
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Dialog
      open={open !== null}
      onClose={close}
      maxWidth="sm"
      fullWidth
      slotProps={{ paper: { sx: { borderRadius: "16px" } } }}
    >
      {/* Remounted per opening, so a new app or target starts clean. */}
      {open !== null && (
        <LinkAccountFlow
          key={`${open.app.bridge_id}:${open.confirm?.identityId ?? ""}`}
          open={open}
          currentUserId={currentUserId}
          busy={busy}
          onBusy={setBusy}
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
  onClose: () => void;
}) {
  const { app } = open;
  const [waiting, setWaiting] = useState<{ target: LinkTarget; code: LinkCode | null } | null>(
    open.confirm === null ? null : { target: open.confirm, code: null },
  );
  const platform = platformLabel(app.bridge_type);

  return (
    <>
      <DialogTitle sx={{ fontSize: "1.0625rem", fontWeight: 600, pt: 3, pr: 8 }}>
        {waiting === null ? `Link your ${platform} account` : `Confirm your ${platform} account`}
      </DialogTitle>
      <IconButton
        aria-label="Close"
        onClick={onClose}
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
            onLinked={onClose}
            onConfirm={(target, code) => setWaiting({ target, code })}
          />
        ) : (
          <LinkConfirmation
            key={waiting.target.identityId}
            app={app}
            target={waiting.target}
            initialCode={waiting.code}
            onBusy={onBusy}
            onConfirmed={onClose}
            onCancelled={() => (open.confirm === null ? setWaiting(null) : onClose())}
            onStartAgain={() => setWaiting(null)}
          />
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, borderTop: "1px solid var(--sw-border)" }}>
        <Button variant="outlined" onClick={onClose} disabled={busy}>
          Close
        </Button>
      </DialogActions>
    </>
  );
}
