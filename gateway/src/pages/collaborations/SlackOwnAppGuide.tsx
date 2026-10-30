import CheckCircleOutline from "@mui/icons-material/CheckCircleOutline";
import ErrorOutline from "@mui/icons-material/ErrorOutline";
import OpenInNew from "@mui/icons-material/OpenInNew";
import { Button, CircularProgress, Paper, Stack, Typography } from "@mui/material";
import { type ReactNode, useEffect, useState } from "react";
import { checkSlackTokens, fetchSlackOwnAppSetup } from "../../data/api";

/** Asked for as required on a Slack app of the workspace's own, whatever the
 * schema says: the app-level token is what opens the connection Slack
 * delivers events down. */
export const SLACK_GUIDE_REQUIRED_FIELDS = ["bot_token", "app_token"] as const;

/** Read from the tokens once they are checked, so not asked for. */
export const SLACK_GUIDE_FILLED_FIELDS = ["workspace_id"] as const;

/** How long to wait after typing stops before checking the tokens. */
const CHECK_DELAY_MS = 600;

type Check =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; workspaceName: string }
  | { state: "failed"; message: string };

function text(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value.trim() : "";
}

function Status({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="flex-start">
      {ok ? (
        <CheckCircleOutline fontSize="small" color="success" />
      ) : (
        <ErrorOutline fontSize="small" color="error" />
      )}
      <Typography variant="body2" color={ok ? "text.primary" : "error"}>
        {children}
      </Typography>
    </Stack>
  );
}

/**
 * Creating a Slack app of the workspace's own, one step at a time: the app
 * opens in Slack already set up for this server, the tokens are checked as
 * they are pasted, and the Slack workspace id is read from them rather than
 * copied by hand.
 */
export default function SlackOwnAppGuide({
  config,
  setField,
}: {
  config: Record<string, unknown>;
  /** Fill in, or clear with null, a field the guide works out itself. */
  setField: (key: string, value: string | null) => void;
}) {
  const [createUrl, setCreateUrl] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const botToken = text(config, "bot_token");
  const appToken = text(config, "app_token");

  useEffect(() => {
    let cancelled = false;
    fetchSlackOwnAppSetup().then(
      (setup) => !cancelled && setCreateUrl(setup.create_url),
      (err: unknown) =>
        !cancelled &&
        setSetupError(err instanceof Error ? err.message : "Could not prepare the Slack app."),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setField("workspace_id", null);
    setCheck({ state: "idle" });
    if (botToken === "" || appToken === "") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setCheck({ state: "checking" });
      checkSlackTokens({ bot_token: botToken, app_token: appToken }).then(
        (checked) => {
          if (cancelled) return;
          setField("workspace_id", checked.workspace_id);
          setCheck({ state: "ok", workspaceName: checked.workspace_name });
        },
        (err: unknown) =>
          !cancelled &&
          setCheck({
            state: "failed",
            message: err instanceof Error ? err.message : "Could not check the tokens.",
          }),
      );
    }, CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [botToken, appToken, setField]);

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5} component="ol" sx={{ m: 0, pl: 2.5 }}>
        <li>
          <Stack spacing={1} alignItems="flex-start">
            <Typography variant="body2">
              Create the app in Slack. It opens already set up for this server.
            </Typography>
            <Button
              size="small"
              variant="outlined"
              endIcon={createUrl ? <OpenInNew fontSize="small" /> : <CircularProgress size={14} />}
              disabled={!createUrl}
              href={createUrl ?? ""}
              target="_blank"
              rel="noopener noreferrer"
            >
              Create the Slack app
            </Button>
            <Typography variant="caption" color="text.secondary">
              Pick your workspace, click Next, then Create.
            </Typography>
            {setupError && <Status ok={false}>{setupError}</Status>}
          </Stack>
        </li>
        <li>
          <Typography variant="body2">
            In Slack, open <b>Install App</b>, click <b>Install to your workspace</b> and allow it.
            Copy the <b>Bot User OAuth Token</b> (xoxb-…) into <b>Bot token</b> below.
          </Typography>
        </li>
        <li>
          <Typography variant="body2">
            Open <b>Basic Information</b>, and under <b>App-Level Tokens</b> click{" "}
            <b>Generate Token and Scopes</b>. Add the <b>connections:write</b> scope, generate, and
            copy the token (xapp-…) into <b>App-level token</b> below.
          </Typography>
        </li>
      </Stack>
      <Stack sx={{ mt: 1.5 }}>
        {check.state === "checking" && (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={14} />
            <Typography variant="body2" color="text.secondary">
              Checking the tokens with Slack…
            </Typography>
          </Stack>
        )}
        {check.state === "ok" && (
          <Status ok>
            Both tokens work, for the <b>{check.workspaceName}</b> workspace.
          </Status>
        )}
        {check.state === "failed" && <Status ok={false}>{check.message}</Status>}
      </Stack>
    </Paper>
  );
}
