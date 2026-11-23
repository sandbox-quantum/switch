import { Alert, Box, Button, CircularProgress, Stack } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router";
import {
  ApiError,
  type BrowserHandoffPeek,
  errorText,
  peekBrowserHandoff,
  redeemBrowserHandoff,
} from "../../data/api";
import { AuthCard } from "./AuthLayout";

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
 * copied link; it only ever leaves in a request body.
 *
 * Only a browser already signed in as the same person goes straight through.
 * Any other is asked first, one with no session included: otherwise someone
 * could make a link for their own account, get you to open it within its
 * minute, and leave you working in their account without a word. */
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
      if (link.same_person) await redeem(taken);
      else setState({ kind: "ask", code: taken, link });
    })();
  }, []);

  if (state.kind === "refused") {
    return (
      <AuthCard
        title="Couldn't sign you in"
        subtitle="Switch Console's sign-in link didn't work."
        notice={null}
        footer={null}
      >
        <Stack spacing={2}>
          <Alert severity="warning">{state.message}</Alert>
          <Button variant="contained" fullWidth component={RouterLink} to="/login">
            Sign in
          </Button>
        </Stack>
      </AuthCard>
    );
  }

  if (state.kind === "ask") {
    const { link } = state;
    return (
      <AuthCard
        title="Opening a page from Switch Console"
        subtitle={
          link.signed_in_as === null
            ? `Switch Console is signing this browser in as ${person(link)}. Continue?`
            : `You're signed in here as ${person(link.signed_in_as)}. Continue as ${person(link)}?`
        }
        notice={null}
        footer={null}
      >
        <Stack spacing={1}>
          {link.workspace_name && (
            <Alert severity="info" sx={{ mb: 1 }}>{`The page opens in ${link.workspace_name}.`}</Alert>
          )}
          <Button variant="contained" fullWidth onClick={() => void redeem(state.code)}>
            {`Continue as ${link.name}`}
          </Button>
          {link.signed_in_as === null ? (
            <Button variant="outlined" fullWidth component={RouterLink} to="/login">
              Sign in another way
            </Button>
          ) : (
            <Button variant="outlined" fullWidth onClick={() => window.location.replace("/")}>
              {`Stay as ${link.signed_in_as.name}`}
            </Button>
          )}
        </Stack>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Opening a page from Switch Console"
      subtitle="Signing you in…"
      notice={null}
      footer={null}
    >
      <Box sx={{ display: "flex", justifyContent: "center", py: 1 }}>
        <CircularProgress size={24} aria-label="Signing you in" />
      </Box>
    </AuthCard>
  );
}

