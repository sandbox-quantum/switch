import Check from "@mui/icons-material/Check";
import ExpandMoreOutlined from "@mui/icons-material/ExpandMoreOutlined";
import { Alert, Button, Menu, MenuItem, Snackbar, Typography } from "@mui/material";
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

/** Dev builds only (`layout/DevRoleSlot.tsx`): shows the dashboard as each
 * permission level by signing in as a test account that holds it. The server
 * sees that account and nothing else, so every check is the one a real person
 * meets. Looks like the design prototype's role control: plain text in the top
 * bar, naming the role you are looking as. */
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
  const role = session === null ? "signed out" : (current?.label ?? "other account");
  const open = anchor !== null;

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
      <Button
        id="dev-role-switcher"
        color="inherit"
        disabled={switching}
        aria-haspopup="menu"
        aria-controls={open ? "dev-role-switcher-menu" : undefined}
        aria-expanded={open}
        onClick={(event) => setAnchor(event.currentTarget)}
        endIcon={
          <ExpandMoreOutlined
            sx={{ fontSize: 14, transition: "transform 150ms", transform: open ? "rotate(180deg)" : "none" }}
          />
        }
        sx={{
          height: "auto",
          minWidth: 0,
          px: 0.5,
          fontWeight: 400,
          color: "text.secondary",
          "&:hover": { color: "text.primary", backgroundColor: "transparent" },
          "& .MuiButton-endIcon": { ml: 0.5 },
        }}
      >
        Role: {role}
      </Button>
      <Menu
        id="dev-role-switcher-menu"
        anchorEl={anchor}
        open={open}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ list: { "aria-labelledby": "dev-role-switcher", dense: true, sx: { py: 0.5 } } }}
      >
        <Typography
          variant="body2"
          sx={{
            maxWidth: 280,
            px: 1.5,
            pt: 0.75,
            pb: 1,
            mb: 0.5,
            color: "text.secondary",
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          Dev only. Picking a role signs you in as a test account that holds it, so every page shows
          what that person sees.
        </Typography>
        {accounts?.map((account) => {
          const active = account === current;
          return (
            <MenuItem
              key={account.role}
              role="menuitemradio"
              aria-checked={active}
              disabled={switching}
              onClick={() => void choose(account)}
              sx={{
                gap: 1,
                mx: 0.5,
                fontWeight: active ? 500 : 400,
                color: active ? "text.primary" : "text.secondary",
                "&:hover": { color: "text.primary" },
              }}
            >
              <Check sx={{ fontSize: 14, opacity: active ? 1 : 0 }} />
              {account.label}
            </MenuItem>
          );
        })}
        {accounts === null && (
          <Typography variant="body2" sx={{ maxWidth: 280, px: 1.5, py: 0.75 }}>
            No test accounts yet. Run <code>just seed-dev-roles</code>, then reload.
          </Typography>
        )}
        {accountsError !== null && (
          <Alert severity="error" sx={{ mx: 1, my: 0.5, maxWidth: 280 }}>
            {accountsError}
          </Alert>
        )}
        {switchError !== null && (
          <Alert severity="error" sx={{ mx: 1, my: 0.5, maxWidth: 280 }}>
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
