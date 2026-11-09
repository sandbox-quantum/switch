import ArrowDropDown from "@mui/icons-material/ArrowDropDown";
import Check from "@mui/icons-material/Check";
import {
  Alert,
  Box,
  Button,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Menu,
  MenuItem,
  Snackbar,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { useAuth } from "../data/AuthContext";
import {
  type DevAccount,
  type Note,
  fetchDevAccounts,
  signInAs,
  storeNote,
  takeNote,
} from "./devRoleAccounts";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Dev builds only (`App.tsx`): shows the dashboard as each permission level
 * by signing in as a test account that holds it. The server sees that account
 * and nothing else, so every check is the one a real person meets. */
export default function DevRoleSwitcher() {
  const { session, loading } = useAuth();
  // Undefined until the dev server answers; null when nothing is seeded.
  const [accounts, setAccounts] = useState<DevAccount[] | null>();
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);

  useEffect(() => {
    fetchDevAccounts().then(setAccounts, (err) => setAccountsError(errorMessage(err)));
  }, []);

  useEffect(() => {
    const left = takeNote();
    if (left !== null) setNote(left);
  }, []);

  if (loading) return null;

  const email = session?.user.email.toLowerCase();
  const current = accounts?.find((account) => account.email.toLowerCase() === email);
  const viewingAs = session === null ? "signed out" : (current?.label ?? session.user.name);

  async function choose(account: DevAccount) {
    setSwitching(true);
    setSwitchError(null);
    let left: Note | null;
    try {
      left = await signInAs(account, session?.tenant ?? null);
    } catch (err) {
      setSwitchError(errorMessage(err));
      setSwitching(false);
      return;
    }
    if (left !== null) storeNote(left);
    // A full reload, as switching workspace does: everything on the page was
    // fetched as the account it was opened by.
    window.location.reload();
  }

  return (
    <>
      <Box
        sx={{
          position: "fixed",
          top: "calc((var(--top-bar-height) - 1.875rem) / 2)",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: "appBar",
        }}
      >
        <Button
          id="dev-role-switcher"
          variant="contained"
          color="warning"
          size="small"
          disabled={switching}
          endIcon={<ArrowDropDown />}
          aria-haspopup="menu"
          aria-controls={anchor !== null ? "dev-role-switcher-menu" : undefined}
          aria-expanded={anchor !== null ? "true" : undefined}
          onClick={(event) => setAnchor(event.currentTarget)}
          sx={{ height: "1.875rem", boxShadow: 2 }}
        >
          Dev · Viewing as {viewingAs}
        </Button>
      </Box>
      <Menu
        id="dev-role-switcher-menu"
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        transformOrigin={{ vertical: "top", horizontal: "center" }}
        slotProps={{ list: { "aria-labelledby": "dev-role-switcher", dense: true } }}
      >
        <ListSubheader>View the dashboard as</ListSubheader>
        {accounts?.map((account) => (
          <MenuItem
            key={account.role}
            selected={account === current}
            disabled={switching}
            onClick={() => void choose(account)}
          >
            <ListItemIcon>{account === current && <Check fontSize="small" />}</ListItemIcon>
            <ListItemText primary={account.label} secondary={account.email} />
          </MenuItem>
        ))}
        {accounts === null && (
          <Typography variant="body2" sx={{ px: 2, py: 1, maxWidth: 320 }}>
            No test accounts yet. Run <code>just seed-dev-roles</code>, then reload.
          </Typography>
        )}
        {accountsError !== null && (
          <Alert severity="error" sx={{ mx: 1, maxWidth: 320 }}>
            {accountsError}
          </Alert>
        )}
        {switchError !== null && (
          <Alert severity="error" sx={{ mx: 1, maxWidth: 320 }}>
            Could not sign in: {switchError}
          </Alert>
        )}
      </Menu>
      {note !== null && (
        <Snackbar
          open
          autoHideDuration={note.severity === "info" ? 8000 : null}
          onClose={() => setNote(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        >
          <Alert severity={note.severity} variant="filled" onClose={() => setNote(null)}>
            {note.text}
          </Alert>
        </Snackbar>
      )}
    </>
  );
}
