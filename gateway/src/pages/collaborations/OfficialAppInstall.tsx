import { Alert, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { useState } from "react";
import { beginAppInstall } from "../../data/api";
import { titleCase } from "../../theme/format";
import { rememberInstallReturn } from "../messaging-apps/installReturn";

/**
 * Adds this server's own app for `platform` to the person's workspace on it,
 * as Console's connect window does. The platform's consent page takes this
 * tab, and once it approves, Switch hands the install back to the dashboard,
 * which connects it and comes back here.
 */
export default function OfficialAppInstall({ platform }: { platform: string }) {
  const name = titleCase(platform);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const url = await beginAppInstall(platform);
      rememberInstallReturn(window.location.pathname + window.location.search);
      // A top-level navigation: the consent page refuses to be framed, and a
      // tab opened after an await is what a browser blocks. `starting` stays
      // set, as the page is on its way out.
      window.location.href = url;
    } catch (caught) {
      setStarting(false);
      setError(caught instanceof Error ? caught.message : `Could not start adding ${name}.`);
    }
  };

  return (
    <Stack spacing={1} alignItems="flex-start">
      <Typography variant="body2" color="text.secondary">
        Adds Switch's own {name} app to your {name} workspace. {name} asks you to approve it, then
        you come back here; there are no tokens to copy.
      </Typography>
      <Button
        variant="contained"
        onClick={() => void start()}
        disabled={starting}
        startIcon={starting ? <CircularProgress size={16} /> : undefined}
      >
        {starting ? `Opening ${name}…` : `Add to ${name}`}
      </Button>
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  );
}
