import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  type PendingInstall,
  cancelInstall,
  connectInstall,
  fetchPendingInstall,
} from "../../data/api";
import { titleCase } from "../../theme/format";
import { takeInstallReturn } from "./installReturn";

/** The install the callback handed over, read from the address's fragment once and then cleared from it. */
function handedOver(): { platform: string; ticket: string } | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const platform = params.get("platform");
  const ticket = params.get("ticket");
  if (window.location.hash)
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return platform && ticket ? { platform, ticket } : null;
}

type State =
  | { kind: "reading" }
  | { kind: "connecting" }
  | { kind: "asking"; pending: PendingInstall }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

/**
 * Where an install of Switch's own app comes back to after the platform
 * approved it. Whoever started it, signed in here, is connected at once and
 * taken back to where they started; anyone else is shown what it connects
 * first, as the install's own page shows it.
 */
export default function FinishInstallPage() {
  const navigate = useNavigate();
  const [handed] = useState(handedOver);
  const [state, setState] = useState<State>({ kind: "reading" });
  const started = useRef(false);

  const connect = async (platform: string, ticket: string, confirmed: boolean) => {
    setState({ kind: "connecting" });
    try {
      await connectInstall(platform, ticket, confirmed);
      navigate(takeInstallReturn(), { replace: true });
    } catch (caught) {
      setState({ kind: "failed", message: caught instanceof Error ? caught.message : String(caught) });
    }
  };

  useEffect(() => {
    if (started.current || handed === null) return;
    started.current = true;
    void (async () => {
      try {
        const pending = await fetchPendingInstall(handed.platform, handed.ticket);
        if (pending.started_by_you) await connect(handed.platform, handed.ticket, false);
        else setState({ kind: "asking", pending });
      } catch (caught) {
        setState({ kind: "failed", message: caught instanceof Error ? caught.message : String(caught) });
      }
    })();
  }, [handed]);

  if (handed === null)
    return (
      <Alert severity="warning">
        Nothing to finish here. Start adding the app again from Messaging apps.
      </Alert>
    );

  const name = titleCase(handed.platform);
  return (
    <Box sx={{ maxWidth: 560, mx: "auto", mt: 6 }}>
      {state.kind === "reading" || state.kind === "connecting" ? (
        <Stack direction="row" spacing={1.5} alignItems="center">
          <CircularProgress size={18} />
          <Typography>Connecting {name}…</Typography>
        </Stack>
      ) : state.kind === "asking" ? (
        <Stack spacing={2}>
          <Typography variant="h6">Connect this {name} workspace to Switch?</Typography>
          <Typography variant="body2" color="text.secondary">
            {state.pending.requested_by} started this install. Check where it connects before
            connecting it.
          </Typography>
          <Typography variant="body2">
            {name} workspace: {state.pending.workspace_name} ({state.pending.external_workspace_id})
          </Typography>
          <Typography variant="body2">Switch organization: {state.pending.organisation}</Typography>
          <Stack direction="row" spacing={1}>
            <Button variant="contained" onClick={() => void connect(handed.platform, handed.ticket, true)}>
              Connect
            </Button>
            <Button
              onClick={() =>
                void cancelInstall(handed.platform, handed.ticket).then(
                  () => setState({ kind: "cancelled" }),
                  (caught: unknown) =>
                    setState({
                      kind: "failed",
                      message: caught instanceof Error ? caught.message : String(caught),
                    }),
                )
              }
            >
              Cancel
            </Button>
          </Stack>
        </Stack>
      ) : state.kind === "cancelled" ? (
        <Alert severity="info">
          Nothing was connected. The {name} workspace may still list the app; remove it there if you
          no longer want it.
        </Alert>
      ) : (
        <Stack spacing={2}>
          <Alert severity="error">{state.message}</Alert>
          <Button sx={{ alignSelf: "flex-start" }} onClick={() => navigate("/settings/messaging-apps")}>
            Go to Messaging apps
          </Button>
        </Stack>
      )}
    </Box>
  );
}
