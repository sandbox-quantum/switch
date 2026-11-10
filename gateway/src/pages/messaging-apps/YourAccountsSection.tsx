import AddLinkOutlined from "@mui/icons-material/AddLinkOutlined";
import ScheduleOutlined from "@mui/icons-material/ScheduleOutlined";
import { Alert, Box, Button, Chip, CircularProgress, Divider, Stack, Tooltip, Typography } from "@mui/material";
import { Fragment, type ReactElement, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import BrandTile from "../../components/connectors/BrandTile";
import InfoTip from "../../components/InfoTip";
import { type BridgeDetail, cancelLinkRequest, releaseBridgeIdentity } from "../../data/api";
import { formatDate, platformLabel, sentenceCase } from "../../theme/format";
import {
  type AccountLine,
  accountHandle,
  accountsByApp,
  findableNote,
  unavailableReason,
} from "./chatAccounts";
import LinkAccountDialog, { type LinkDialogOpen } from "./LinkAccountDialog";
import type { MyAccounts } from "./useMyAccounts";

/** Beside a link made before links had to be confirmed. */
const NOT_CONFIRMED_HELP =
  "This link was made before Switch asked accounts to confirm their links. It still works. Confirm it by posting a one-time code from the account.";

/** Beside a link waiting for its code, which is not a link yet. */
const WAITING_HELP =
  "This account isn't linked until a one-time code is posted from it. Until then your agents don't recognise you here.";

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
  showHeading,
}: {
  /** The workspace's messaging apps, null until they have loaded. */
  apps: BridgeDetail[] | null;
  /** Loading them failed. */
  appsFailed: boolean;
  accounts: MyAccounts;
  logos: ReadonlyMap<string, string>;
  currentUserId: string | null;
  /** The heading tells this section apart from the admin's table; on a page
   *  holding only this list it is left out. */
  showHeading: boolean;
}) {
  const [dialog, setDialog] = useState<LinkDialogOpen | null>(null);
  const [toUnlink, setToUnlink] = useState<{ app: BridgeDetail; line: AccountLine } | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { linked, pending, refresh } = accounts;

  const cancel = async (app: BridgeDetail, line: AccountLine) => {
    setCancelling(line.id);
    setError(null);
    try {
      await cancelLinkRequest(app.bridge_id, line.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel the link.");
    } finally {
      setCancelling(null);
      // Either way: a refusal means it was confirmed or cancelled meanwhile.
      refresh();
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
  if (apps === null || linked === null || pending === null) {
    body =
      appsFailed || accounts.error !== null ? (
        <Alert severity="error">Could not load your accounts. Reload the page to try again.</Alert>
      ) : (
        <CircularProgress size={24} />
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
      <Box sx={{ border: "1px solid var(--sw-border)", borderRadius: "16px", px: 2 }}>
        {groups.map(({ app, accounts: lines }, i) => (
          <Fragment key={app.bridge_id}>
            {i > 0 && <Divider />}
            <AppAccounts
              app={app}
              lines={lines}
              logoUrl={logos.get(app.bridge_type) ?? null}
              cancelling={cancelling}
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
              onUnlink={(line) => setToUnlink({ app, line })}
            />
          </Fragment>
        ))}
      </Box>
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

      <LinkAccountDialog
        open={dialog}
        currentUserId={currentUserId}
        pending={pending ?? []}
        onClose={() => {
          setDialog(null);
          refresh();
        }}
      />

      <ConfirmDialog
        open={toUnlink !== null}
        title="Unlink chat account"
        description={
          toUnlink &&
          `${accountHandle(toUnlink.line.username)} in ${toUnlink.app.display_name} will stop being recognised as you. Agents there will treat your messages as coming from an unknown person until you link it again.`
        }
        confirmLabel="Unlink"
        tone="destructive"
        onConfirm={async () => {
          if (toUnlink === null) return;
          try {
            await releaseBridgeIdentity(toUnlink.app.bridge_id, toUnlink.line.id);
          } finally {
            refresh();
          }
        }}
        onClose={() => setToUnlink(null)}
      />
    </Box>
  );
}

function AppAccounts({
  app,
  lines,
  logoUrl,
  cancelling,
  onLink,
  onConfirm,
  onCancel,
  onUnlink,
}: {
  app: BridgeDetail;
  lines: AccountLine[];
  logoUrl: string | null;
  cancelling: string | null;
  onLink: () => void;
  onConfirm: (line: AccountLine) => void;
  onCancel: (line: AccountLine) => void;
  onUnlink: (line: AccountLine) => void;
}) {
  const platform = platformLabel(app.bridge_type);
  const unavailable = unavailableReason(app);
  const findable = findableNote(app);

  return (
    <Stack direction="row" spacing={2} sx={{ py: 2 }} alignItems="flex-start">
      <BrandTile slug={app.bridge_type} name={platform} size={36} logoUrl={logoUrl} />
      <Box sx={{ minWidth: 0, flexGrow: 1 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 36 }}>
          <Typography variant="body2" noWrap sx={{ fontWeight: 500, flexGrow: 1, minWidth: 0 }}>
            {platform} · {app.display_name}
          </Typography>
          {app.status !== "active" && <Chip size="small" label={sentenceCase(app.status)} />}
          <Guarded reason={unavailable}>
            <Button
              variant={lines.length === 0 ? "outlined" : "text"}
              size="small"
              startIcon={<AddLinkOutlined fontSize="small" />}
              disabled={unavailable !== null}
              onClick={onLink}
            >
              {lines.length === 0 ? "Link account" : "Link another account"}
            </Button>
          </Guarded>
        </Stack>

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
              line={line}
              unavailable={unavailable}
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
  line,
  unavailable,
  cancelling,
  onConfirm,
  onCancel,
  onUnlink,
}: {
  line: AccountLine;
  unavailable: string | null;
  cancelling: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onUnlink: () => void;
}) {
  const handle = accountHandle(line.username);
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
          <InfoTip>{line.kind === "pending" ? WAITING_HELP : NOT_CONFIRMED_HELP}</InfoTip>
        )}
      </Stack>
      {line.kind !== "linked" && (
        <Guarded reason={unavailable}>
          <Button size="small" variant="outlined" disabled={unavailable !== null} onClick={onConfirm}>
            {line.kind === "pending" ? "Show code" : "Confirm"}
          </Button>
        </Guarded>
      )}
      {line.kind === "pending" ? (
        <Button size="small" color="inherit" loading={cancelling} onClick={onCancel}>
          Cancel link
        </Button>
      ) : (
        <Button size="small" variant="outlined" color="error" onClick={onUnlink}>
          Unlink
        </Button>
      )}
    </Stack>
  );
}

/** A control that may be unavailable, with the reason a hover away: a greyed
 * button with no explanation is the thing people file bugs about. */
function Guarded({ reason, children }: { reason: string | null; children: ReactElement }) {
  if (reason === null) return children;
  return (
    <Tooltip title={reason}>
      <span>{children}</span>
    </Tooltip>
  );
}
