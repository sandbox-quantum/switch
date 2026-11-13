import AddLinkOutlined from "@mui/icons-material/AddLinkOutlined";
import OpenInNewOutlined from "@mui/icons-material/OpenInNewOutlined";
import ScheduleOutlined from "@mui/icons-material/ScheduleOutlined";
import { Alert, Box, Button, Chip, CircularProgress, Divider, Snackbar, Stack, Typography } from "@mui/material";
import { Fragment, useEffect, useRef, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import BrandTile from "../../components/connectors/BrandTile";
import InfoTip from "../../components/InfoTip";
import { ApiError, type BridgeDetail, cancelLinkRequest, releaseBridgeIdentity } from "../../data/api";
import { formatDate, platformLabel, sentenceCase } from "../../theme/format";
import {
  type AccountLine,
  accountHandle,
  accountsByApp,
  findableNote,
  statusColor,
  unavailableReason,
} from "./chatAccounts";
import LinkAccountDialog, { type LinkDialogOpen, type LinkOutcome } from "./LinkAccountDialog";
import type { MyAccounts } from "./useMyAccounts";

/** Beside a link made before links had to be confirmed. */
const NOT_CONFIRMED_HELP =
  "This link was made before Switch asked accounts to confirm their links. It still works. Confirm it from the account: by tapping the number in a message from Switch, where Switch can send one, or by posting a one-time code.";

/** Beside a link waiting to be confirmed, which is not a link yet. */
const WAITING_HELP =
  "This account isn't linked until it confirms the link: by tapping the number in a message from Switch, where Switch can send one, or by posting a one-time code. Until then your agents don't recognise you here.";

/**
 * Who you are in each messaging app connected to the workspace: every role
 * sees this, since linking is something each person does for themselves.
 * Agents set to answer only their owner recognise someone only through an
 * account linked here.
 *
 * One block per app, listing each of your accounts in it with what can be
 * done to that account. A person may hold several accounts in one app, or a
 * link waiting next to one that counts, so an app is a list, never one slot.
 */
export default function YourAccountsSection({
  apps,
  appsFailed,
  accounts,
  logos,
  currentUserId,
  standsHere,
  showHeading,
}: {
  /** The workspace's messaging apps, null until they have loaded. */
  apps: BridgeDetail[] | null;
  /** Loading them failed. */
  appsFailed: boolean;
  accounts: MyAccounts;
  logos: ReadonlyMap<string, string>;
  currentUserId: string | null;
  /** Whether the viewer belongs to the workspace. The platform operator can
   *  enter one they do not, and Switch links accounts only to its people. */
  standsHere: boolean;
  /** The heading tells this section apart from the admin's table; on a page
   *  holding only this list it is left out. */
  showHeading: boolean;
}) {
  const [dialog, setDialog] = useState<LinkDialogOpen | null>(null);
  const [toUnlink, setToUnlink] = useState<{ app: BridgeDetail; line: AccountLine; others: string[] } | null>(
    null,
  );
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The app whose block takes focus next: after an account's row is removed,
  // the button that opened the dialog is gone, and focus would fall to the
  // top of the page.
  const [focusApp, setFocusApp] = useState<string | null>(null);
  const { linked, pending, refresh } = accounts;

  const cancel = async (app: BridgeDetail, line: AccountLine) => {
    setCancelling(line.id);
    setError(null);
    try {
      await cancelLinkRequest(app.bridge_id, line.id);
      setFocusApp(app.bridge_id);
    } catch (e) {
      // Nothing was waiting: confirmed from the account since this row was
      // read (a number tapped on a phone), or cancelled elsewhere. The re-read
      // below shows which, so it is not an error to report.
      if (!(e instanceof ApiError && e.status === 404)) {
        setError(e instanceof Error ? e.message : "Could not cancel the link.");
      }
    } finally {
      setCancelling(null);
      // Either way: a refusal means it was confirmed or cancelled meanwhile.
      refresh();
    }
  };

  const closeDialog = (outcome: LinkOutcome | null) => {
    if (dialog !== null) setFocusApp(dialog.app.bridge_id);
    setDialog(null);
    refresh();
    if (outcome !== null) {
      setNotice(
        outcome.kind === "linked"
          ? `Linked ${outcome.handle} in ${outcome.app.display_name}.`
          : `${outcome.handle} in ${outcome.app.display_name} is confirmed.`,
      );
    }
  };

  const heading = showHeading && (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
      <Typography variant="h6" component="h2">
        Your accounts
      </Typography>
      <InfoTip>Agents use these to tell it&apos;s you talking.</InfoTip>
    </Stack>
  );

  let body;
  if (!standsHere) {
    body = (
      <Typography variant="body2" color="text.secondary">
        You&apos;re here as the platform operator, not as a member of this workspace, so there are no accounts of
        yours to link here.
      </Typography>
    );
  } else if (apps === null || linked === null || pending === null) {
    body =
      appsFailed || accounts.error !== null ? (
        <Alert severity="error">Could not load your accounts. Reload the page to try again.</Alert>
      ) : (
        <CircularProgress size={24} aria-label="Loading your accounts" />
      );
  } else if (apps.length === 0) {
    body = (
      <Typography variant="body2" color="text.secondary">
        No messaging apps are connected to this workspace yet.
      </Typography>
    );
  } else {
    const groups = accountsByApp(apps, linked, pending);
    body = (
      <>
        {/* A re-read that failed after the lists loaded: what is shown may
            be out of date, and the page says so rather than looking fine. */}
        {accounts.error !== null && (
          <Alert severity="warning" sx={{ mb: 2, overflowWrap: "anywhere" }}>
            Couldn&apos;t refresh your accounts, so this may be out of date: {accounts.error}
          </Alert>
        )}
        <Box sx={{ border: "1px solid var(--sw-border)", borderRadius: "16px", px: 2 }}>
          {groups.map(({ app, accounts: lines }, i) => (
            <Fragment key={app.bridge_id}>
              {i > 0 && <Divider />}
              <AppAccounts
                app={app}
                lines={lines}
                logoUrl={logos.get(app.bridge_type) ?? null}
                cancelling={cancelling}
                takeFocus={focusApp === app.bridge_id}
                onFocusTaken={() => setFocusApp(null)}
                onLink={() => setDialog({ app, confirm: null })}
                onConfirm={(line) =>
                  setDialog({
                    app,
                    confirm: {
                      identityId: line.id,
                      username: line.username,
                      kind: line.kind === "pending" ? "pending" : "unverified",
                    },
                  })
                }
                onCancel={(line) => void cancel(app, line)}
                onUnlink={(line) =>
                  setToUnlink({
                    app,
                    line,
                    others: lines
                      .filter((other) => other.id !== line.id && other.kind !== "pending")
                      .map((other) => accountHandle(other.username)),
                  })
                }
              />
            </Fragment>
          ))}
        </Box>
      </>
    );
  }

  return (
    <Box component="section" aria-label="Your accounts">
      {heading}
      {error !== null && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {body}

      <LinkAccountDialog open={dialog} currentUserId={currentUserId} onClose={closeDialog} />

      <ConfirmDialog
        open={toUnlink !== null}
        title="Unlink chat account"
        description={toUnlink && unlinkText(toUnlink.app, toUnlink.line, toUnlink.others)}
        confirmLabel="Unlink"
        tone="destructive"
        onConfirm={async () => {
          if (toUnlink === null) return;
          try {
            await releaseBridgeIdentity(toUnlink.app.bridge_id, toUnlink.line.id);
            setFocusApp(toUnlink.app.bridge_id);
          } finally {
            refresh();
          }
        }}
        onClose={() => setToUnlink(null)}
      />

      <Snackbar open={notice !== null} autoHideDuration={6000} onClose={() => setNotice(null)}>
        {notice !== null ? (
          <Alert severity="success" onClose={() => setNotice(null)}>
            {notice}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}

/** What unlinking costs, said for the case at hand: with another account
 * still linked in the same app, agents there go on recognising the person. */
function unlinkText(app: BridgeDetail, line: AccountLine, others: string[]): string {
  const handle = accountHandle(line.username);
  return others.length === 0
    ? `${handle} in ${app.display_name} will stop being recognised as you. Agents there will treat your messages as coming from an unknown person until you link it again.`
    : `${handle} in ${app.display_name} will stop being recognised as you. You stay linked there as ${others.join(", ")}.`;
}

function AppAccounts({
  app,
  lines,
  logoUrl,
  cancelling,
  takeFocus,
  onFocusTaken,
  onLink,
  onConfirm,
  onCancel,
  onUnlink,
}: {
  app: BridgeDetail;
  lines: AccountLine[];
  logoUrl: string | null;
  cancelling: string | null;
  takeFocus: boolean;
  onFocusTaken: () => void;
  onLink: () => void;
  onConfirm: (line: AccountLine) => void;
  onCancel: (line: AccountLine) => void;
  onUnlink: (line: AccountLine) => void;
}) {
  const platform = platformLabel(app.bridge_type);
  const unavailable = unavailableReason(app);
  const findable = findableNote(app);
  const counting = lines.some((line) => line.kind !== "pending");
  // The bundled Mattermost is named after its platform, and "Mattermost ·
  // Mattermost" says nothing twice.
  const title = app.display_name === platform ? platform : `${platform} · ${app.display_name}`;
  const linkButton = useRef<HTMLButtonElement>(null);
  const block = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!takeFocus) return;
    // The link button, unless it is disabled; then the block itself.
    (linkButton.current && !linkButton.current.disabled ? linkButton.current : block.current)?.focus();
    onFocusTaken();
  }, [takeFocus, onFocusTaken]);

  return (
    <Stack
      ref={block}
      tabIndex={-1}
      direction="row"
      spacing={2}
      sx={{ py: 2, outline: "none" }}
      alignItems="flex-start"
      aria-label={title}
      role="group"
    >
      <BrandTile slug={app.bridge_type} name={platform} size={36} logoUrl={logoUrl} />
      <Box sx={{ minWidth: 0, flexGrow: 1 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 36 }}>
          <Typography variant="body2" noWrap sx={{ fontWeight: 500, flexGrow: 1, minWidth: 0 }}>
            {title}
          </Typography>
          {app.status !== "active" && (
            <Chip size="small" label={sentenceCase(app.status)} color={statusColor(app.status)} />
          )}
          {app.home_url && (
            <Button
              size="small"
              color="inherit"
              startIcon={<OpenInNewOutlined fontSize="small" />}
              href={app.home_url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`Open ${app.display_name}`}
            >
              Open
            </Button>
          )}
          <Button
            ref={linkButton}
            variant={lines.length === 0 ? "outlined" : "text"}
            size="small"
            startIcon={<AddLinkOutlined fontSize="small" />}
            disabled={unavailable !== null}
            aria-label={counting ? `Link another account in ${app.display_name}` : `Link account in ${app.display_name}`}
            onClick={onLink}
          >
            {counting ? "Link another account" : "Link account"}
          </Button>
        </Stack>

        {/* Said in the row, not in a tooltip on the greyed buttons, which a
            keyboard cannot reach. */}
        {unavailable !== null && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
            {unavailable}
          </Typography>
        )}

        {lines.length === 0 ? (
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Typography variant="body2" color="text.secondary">
              Not linked
            </Typography>
            {findable && <InfoTip label="How to become findable">{findable}</InfoTip>}
          </Stack>
        ) : (
          lines.map((line) => (
            <AccountRow
              key={`${line.kind}:${line.id}`}
              app={app}
              line={line}
              unavailable={unavailable !== null}
              cancelling={cancelling === line.id}
              onConfirm={() => onConfirm(line)}
              onCancel={() => onCancel(line)}
              onUnlink={() => onUnlink(line)}
            />
          ))
        )}
      </Box>
    </Stack>
  );
}

function AccountRow({
  app,
  line,
  unavailable,
  cancelling,
  onConfirm,
  onCancel,
  onUnlink,
}: {
  app: BridgeDetail;
  line: AccountLine;
  unavailable: boolean;
  cancelling: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onUnlink: () => void;
}) {
  const handle = accountHandle(line.username);
  // Every row's buttons say whose they are: "Unlink" ten times over tells a
  // screen reader nothing.
  const whose = `${handle} in ${app.display_name}`;
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 0.5 }} data-testid="account-line">
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0, flexGrow: 1 }}>
        {line.kind === "pending" && <ScheduleOutlined sx={{ fontSize: 14, color: "text.secondary" }} />}
        <Typography variant="body2" color="text.secondary" noWrap>
          {line.kind === "pending"
            ? `${handle} · Waiting for confirmation${line.requestedBy ? ` · started by ${line.requestedBy}` : ""}`
            : `${handle} · linked ${formatDate(line.linkedAt)}`}
        </Typography>
        {line.kind === "unverified" && <Chip size="small" label="Not confirmed" />}
        {line.kind !== "linked" && (
          <InfoTip label={`About ${whose}`}>{line.kind === "pending" ? WAITING_HELP : NOT_CONFIRMED_HELP}</InfoTip>
        )}
      </Stack>
      {line.kind !== "linked" && (
        <Button
          size="small"
          variant="outlined"
          disabled={unavailable}
          aria-label={line.kind === "pending" ? `Finish linking ${whose}` : `Confirm ${whose}`}
          onClick={onConfirm}
        >
          {line.kind === "pending" ? "Finish linking" : "Confirm"}
        </Button>
      )}
      {line.kind === "pending" ? (
        <Button size="small" color="inherit" loading={cancelling} aria-label={`Cancel link to ${whose}`} onClick={onCancel}>
          Cancel link
        </Button>
      ) : (
        <Button size="small" variant="outlined" color="error" aria-label={`Unlink ${whose}`} onClick={onUnlink}>
          Unlink
        </Button>
      )}
    </Stack>
  );
}
