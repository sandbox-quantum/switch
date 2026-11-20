import { Alert, Button, CircularProgress, Link, Stack, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { type BridgeDetail, beginAppInstall, fetchBridges } from "../../data/api";
import { titleCase } from "../../theme/format";

/** How often to look for the new connection while the person approves the app in the other tab. */
export const INSTALL_POLL_INTERVAL_MS = 3000;

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; known: ReadonlySet<string>; url: string };

/**
 * Adds this server's own app for `platform` to the person's workspace on it,
 * as Console's connect window does: the platform's consent screen opens in a
 * new tab, and the server finishes the install on its public callback, so the
 * only sign it worked is a connection of that platform this window has not
 * seen before. It watches for one, and hands it over.
 */
export default function OfficialAppInstall({
  platform,
  onInstalled,
}: {
  platform: string;
  onInstalled: (bridge: BridgeDetail) => void;
}) {
  const name = titleCase(platform);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  useEffect(() => {
    if (phase.kind !== "waiting") return;
    let live = true;
    const look = async () => {
      try {
        const found = (await fetchBridges())?.find(
          (bridge) => bridge.bridge_type === platform && !phase.known.has(bridge.bridge_id),
        );
        if (!live) return;
        setCheckError(null);
        if (found) onInstalled(found);
      } catch (caught) {
        if (live)
          setCheckError(
            `Could not check whether ${name} is connected yet; still trying. (${caught instanceof Error ? caught.message : String(caught)})`,
          );
      }
    };
    const timer = setInterval(() => void look(), INSTALL_POLL_INTERVAL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [phase, platform, name, onInstalled]);

  const start = async () => {
    // Opened before anything is awaited: a browser blocks a tab opened later,
    // away from the click. Without one, the install takes this tab instead.
    const tab = window.open("", "_blank");
    setPhase({ kind: "starting" });
    setError(null);
    try {
      const before = (await fetchBridges()) ?? [];
      const url = await beginAppInstall(platform);
      if (tab === null) {
        window.location.href = url;
        return;
      }
      tab.location.href = url;
      setPhase({ kind: "waiting", known: new Set(before.map((bridge) => bridge.bridge_id)), url });
    } catch (caught) {
      tab?.close();
      setPhase({ kind: "idle" });
      setError(caught instanceof Error ? caught.message : `Could not start adding ${name}.`);
    }
  };

  if (phase.kind === "waiting")
    return (
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} alignItems="center">
          <CircularProgress size={16} />
          <Typography variant="body2">Waiting for {name}…</Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          Approve the Switch app in the tab that opened. This moves on as soon as {name} confirms
          it.
        </Typography>
        <Link
          component="button"
          variant="body2"
          sx={{ alignSelf: "flex-start" }}
          onClick={() => window.open(phase.url, "_blank", "noopener")}
        >
          Open the {name} page again
        </Link>
        {checkError && <Alert severity="warning">{checkError}</Alert>}
      </Stack>
    );

  return (
    <Stack spacing={1} alignItems="flex-start">
      <Typography variant="body2" color="text.secondary">
        Adds Switch's own {name} app to your {name} workspace. {name} asks you to approve it; there
        are no tokens to copy.
      </Typography>
      <Button
        variant="contained"
        onClick={() => void start()}
        disabled={phase.kind === "starting"}
        startIcon={phase.kind === "starting" ? <CircularProgress size={16} /> : undefined}
      >
        {phase.kind === "starting" ? `Opening ${name}…` : `Add to ${name}`}
      </Button>
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  );
}
