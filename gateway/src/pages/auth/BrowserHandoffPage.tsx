import { Alert, Box, Button, Card, CircularProgress, Stack, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router";
import {
  ApiError,
  type BrowserHandoffPeek,
  errorText,
  peekBrowserHandoff,
  redeemBrowserHandoff,
} from "../../data/api";

/** Where Switch Console's sign-in link opens. */
export const HANDOFF_PATH = "/auth/handoff";

const EXPIRED =
  "This sign-in link has expired or was already used. Open the page again from Switch Console.";

type State =
  | { kind: "working" }
  | { kind: "ask"; code: string; link: BrowserHandoffPeek }
  | { kind: "refused"; message: string };

/** The code from the address's fragment (`#code=…`), or null without one. */
export function codeFromHash(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, "")).get("code") || null;
}

/** `next` as a path on this dashboard, or `/` if it would leave it. The
 * server only hands out its own pages; this holds even if it did not. */
export function pageToOpen(next: string): string {
  const url = new URL(next, window.location.origin);
  return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : "/";
}

function person(who: { name: string; email: string }): string {
  return `${who.name} (${who.email})`;
}

function refusal(err: unknown): string {
  if (err instanceof ApiError) {
    return err.status === 410 ? errorText(err.detail, EXPIRED) : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** `/auth/handoff#code=…`: sign this browser in with the link Switch Console
 * made, then open the page it was for. The code is read once and dropped
 * from the address straight away, so it stays out of the history and any
 * copied link; it only ever leaves in a request body. A browser signed in as
 * someone else is asked first. */
export default function BrowserHandoffPage() {
  const [state, setState] = useState<State>({ kind: "working" });
  // Kept across a remount, so a second run of the effect (React's strict
  // mode) finds the code the first took off the address, and starts nothing.
  const code = useRef<string | null | undefined>(undefined);

  const redeem = async (taken: string) => {
    setState({ kind: "working" });
    try {
      const { next } = await redeemBrowserHandoff(taken);
      // A full load, so the dashboard starts on the session just set.
      window.location.replace(pageToOpen(next));
    } catch (err) {
      setState({ kind: "refused", message: refusal(err) });
    }
  };

  useEffect(() => {
    if (code.current !== undefined) return;
    const taken = codeFromHash(window.location.hash);
    code.current = taken;
    window.history.replaceState(null, "", HANDOFF_PATH);
    if (taken === null) {
      setState({ kind: "refused", message: EXPIRED });
      return;
    }
    void (async () => {
      let link: BrowserHandoffPeek;
      try {
        link = await peekBrowserHandoff(taken);
      } catch (err) {
        setState({ kind: "refused", message: refusal(err) });
        return;
      }
      if (link.signed_in_as === null || link.same_person) await redeem(taken);
      else setState({ kind: "ask", code: taken, link });
    })();
  }, []);

  return (
    <Box
      sx={{
        display: "flex",
        minHeight: "100vh",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "var(--sw-canvas)",
        py: 4,
      }}
    >
      <Card sx={{ width: 420, p: 4, boxShadow: "var(--sw-shadow-surface)" }}>
        <Typography variant="h6" sx={{ mb: 2 }}>
          Switch Gateway
        </Typography>
        {state.kind === "working" && (
          <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
            <CircularProgress size={20} />
            <Typography variant="body2">Signing you in…</Typography>
          </Stack>
        )}
        {state.kind === "refused" && (
          <Stack spacing={2}>
            <Alert severity="warning">{state.message}</Alert>
            <Button variant="contained" component={RouterLink} to="/login">
              Sign in
            </Button>
          </Stack>
        )}
        {state.kind === "ask" && state.link.signed_in_as !== null && (
          <Stack spacing={2}>
            <Typography variant="body2">
              {`You're signed in here as ${person(state.link.signed_in_as)}. Continue as ${person(state.link)}?`}
            </Typography>
            {state.link.workspace_name && (
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                {`The page opens in ${state.link.workspace_name}.`}
              </Typography>
            )}
            <Button variant="contained" onClick={() => void redeem(state.code)}>
              {`Continue as ${state.link.name}`}
            </Button>
            <Button variant="outlined" onClick={() => window.location.replace("/")}>
              {`Stay as ${state.link.signed_in_as.name}`}
            </Button>
          </Stack>
        )}
      </Card>
    </Box>
  );
}
