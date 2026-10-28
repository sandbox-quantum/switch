import CheckBoxOutlineBlankOutlined from "@mui/icons-material/CheckBoxOutlineBlankOutlined";
import CheckBoxOutlined from "@mui/icons-material/CheckBoxOutlined";
import MoreHorizOutlined from "@mui/icons-material/MoreHorizOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { useState } from "react";
import {
  type ConnectorApp,
  type ConnectorAppCheck,
  type SavedConnectorApp,
  checkConnectorApp,
  importConnectorApp,
} from "../../data/api";
import { formatDate } from "../../theme/hootFormat";
import {
  actionLabel,
  attention,
  type CardAction,
  cardState,
  type CardState,
  changeBlocked,
  configuredSentence,
  type MenuAction,
  menuActions,
  menuLabel,
  moveChecklist,
  notSetUpSentence,
  primaryAction,
  secretSummary,
  stateLabel,
  usedBy,
} from "./connectorApps";
import RemoveDialog from "./RemoveDialog";
import SetupDialog, { type SetupMode } from "./SetupDialog";
import UpdateSecretDialog from "./UpdateSecretDialog";

const CHIP_COLOR: Record<CardState, "success" | "default" | "warning"> = {
  ready: "success",
  not_set_up: "default",
  configured: "success",
  attention: "warning",
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack direction="row" spacing={2}>
      <Typography variant="body2" color="text.secondary" sx={{ width: 90, flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
        {children}
      </Typography>
    </Stack>
  );
}

/** Moving off configuration: copy in, remove the variable, restart. */
function ManageHereDialog({
  app,
  open,
  onClose,
  onImported,
}: {
  app: ConnectorApp;
  open: boolean;
  onClose: () => void;
  onImported: (imported: ConnectorApp) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const items = moveChecklist(app);

  const copy = async () => {
    setBusy(true);
    setError(null);
    try {
      onImported(await importConnectorApp(app.slug));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Manage {app.name} here instead</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          {items.map((item, index) => (
            <Stack key={item.text} direction="row" spacing={1} alignItems="flex-start">
              {item.done ? (
                <CheckBoxOutlined fontSize="small" color="success" aria-label="Done" />
              ) : (
                <CheckBoxOutlineBlankOutlined fontSize="small" aria-label="To do" />
              )}
              <Box sx={{ flexGrow: 1 }}>
                <Typography variant="body2">{item.text}</Typography>
                {index === 0 && !item.done && (
                  <Button
                    size="small"
                    variant="outlined"
                    sx={{ mt: 0.5 }}
                    disabled={busy}
                    onClick={() => void copy()}
                  >
                    Copy into Switch
                  </Button>
                )}
              </Box>
            </Stack>
          ))}
          <Typography variant="body2" color="text.secondary">
            Nobody needs to reconnect: Switch keeps using the same app.
          </Typography>
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * One connector's app: is it working, and what to do next, with one obvious
 * button. Changes that disconnect people are apart from those that don't.
 */
export default function ConnectorAppCard({
  app,
  publicUrl,
  checkFailure,
  onCheckFailure,
  onChanged,
}: {
  app: ConnectorApp;
  /** GATEWAY_PUBLIC_URL; while it is unset the vendor has nowhere to send people back. */
  publicUrl: string | null;
  checkFailure: string | null;
  onCheckFailure: (message: string | null) => void;
  onChanged: (message: string) => void;
}) {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [setup, setSetup] = useState<SetupMode | null>(null);
  const [updating, setUpdating] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [managing, setManaging] = useState(false);
  const [checks, setChecks] = useState<ConnectorAppCheck[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = cardState(app, checkFailure);
  const needs = attention(app, checkFailure);
  const primary = primaryAction(app, checkFailure);
  const actions = menuActions(app);
  const summary = secretSummary(app);
  const blocked = changeBlocked(app, publicUrl);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      const result = await checkConnectorApp(app.slug);
      setChecks(result.checks);
      onCheckFailure(result.ok ? null : (result.checks.find((c) => !c.ok)?.message ?? null));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setChecking(false);
    }
  };

  const run = (action: CardAction) => {
    if (action === "check") void check();
    else if (action === "set_up") setSetup("set_up");
    else if (action === "enter_again") setSetup("enter_again");
    else if (action === "manage_here") setManaging(true);
    else setUpdating(true);
  };

  const choose = (action: MenuAction) => {
    setMenu(null);
    if (action === "update_secret") setUpdating(true);
    else if (action === "switch_app") setSetup("switch");
    else setRemoving(true);
  };

  const saved = (message: string, result: SavedConnectorApp) => {
    setSetup(null);
    setUpdating(false);
    setChecks(result.checks.length > 0 ? result.checks : null);
    onCheckFailure(null);
    onChanged(message);
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-testid={`connector-app-${app.slug}`}>
      <Stack spacing={1.25}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="subtitle1" sx={{ flexGrow: 1, fontWeight: 600 }}>
            {app.name}
          </Typography>
          <Chip size="small" color={CHIP_COLOR[state]} label={stateLabel(state)} />
        </Stack>

        {state === "not_set_up" && (
          <Typography variant="body2" color="text.secondary">
            {notSetUpSentence(app)}
          </Typography>
        )}
        {app.source === "configuration" && (
          <Typography variant="body2" color="text.secondary">
            {configuredSentence(app)}
            {app.setup_blocked ? ` ${app.setup_blocked}` : ""}
          </Typography>
        )}
        {needs && <Alert severity={needs.cause === "stale" ? "info" : "warning"}>{needs.sentence}</Alert>}
        {needs?.cause === "saved_ignored" && app.saved_client_id && (
          <Row label="Saved here">{app.saved_client_id}</Row>
        )}

        {app.client_id && <Row label="Client ID">{app.client_id}</Row>}
        {app.fields.slug && <Row label="App">{app.fields.slug}</Row>}
        {summary && (
          <Row label="Secret">
            {summary}
            {app.updated_by_name && app.updated_at
              ? ` · updated by ${app.updated_by_name}, ${formatDate(app.updated_at)}`
              : ""}
          </Row>
        )}
        {app.source !== "none" && (
          <Typography variant="body2" color="text.secondary">
            {usedBy(app)}
          </Typography>
        )}
        {app.install_url && state !== "not_set_up" && (
          <Typography variant="body2" color="text.secondary">
            People install the App at {app.install_url}
          </Typography>
        )}

        {checks && (
          <Stack spacing={0.5}>
            {checks.map((c) => (
              <Alert key={c.name} severity={c.ok ? "success" : "error"} variant="outlined">
                {c.message}
                {c.note && (
                  <Typography variant="body2" sx={{ mt: 0.5 }}>
                    <strong>Note:</strong> {c.note}
                  </Typography>
                )}
              </Alert>
            ))}
          </Stack>
        )}
        {error && <Alert severity="error">{error}</Alert>}

        <Stack direction="row" justifyContent="flex-end" spacing={1}>
          {primary && (
            <Button
              variant={primary === "check" ? "outlined" : "contained"}
              disabled={checking || (blocked && primary !== "check")}
              onClick={() => run(primary)}
              startIcon={checking ? <CircularProgress size={16} /> : undefined}
            >
              {actionLabel(app, primary)}
            </Button>
          )}
          {actions.length > 0 && (
            <IconButton aria-label={`More for ${app.name}`} onClick={(e) => setMenu(e.currentTarget)}>
              <MoreHorizOutlined />
            </IconButton>
          )}
        </Stack>
      </Stack>

      <Menu anchorEl={menu} open={menu !== null} onClose={() => setMenu(null)}>
        {actions.map((action) => (
          <MenuItem
            key={action}
            disabled={blocked && action !== "remove"}
            onClick={() => choose(action)}
            sx={action === "remove" ? { color: "error.main" } : undefined}
          >
            {menuLabel(app, action)}
          </MenuItem>
        ))}
      </Menu>

      {setup && (
        <SetupDialog
          app={app}
          publicUrl={publicUrl}
          mode={setup}
          open
          onClose={() => setSetup(null)}
          onSaved={(result) => saved(`${app.name} is ready.`, result)}
        />
      )}
      {updating && (
        <UpdateSecretDialog
          app={app}
          open
          onClose={() => setUpdating(false)}
          onSaved={(result) =>
            saved(`${app.name}'s secret is updated. Nobody was disconnected.`, result)
          }
        />
      )}
      {removing && (
        <RemoveDialog
          app={app}
          open
          onClose={() => setRemoving(false)}
          onRemoved={() => {
            setRemoving(false);
            onChanged(`${app.name}'s app is removed.`);
          }}
        />
      )}
      {managing && (
        <ManageHereDialog
          app={app}
          open
          onClose={() => setManaging(false)}
          onImported={() => onChanged(`${app.name} is copied into Switch.`)}
        />
      )}
    </Paper>
  );
}
