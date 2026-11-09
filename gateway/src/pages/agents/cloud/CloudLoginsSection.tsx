import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type LoginStatus,
  listCloudLogins,
  listOperations,
  loginStatus,
  OPERATION_POLL_MS,
  waitForOperation,
  withdrawCloudLogin,
} from "../../../data/cloudLogins";
import type { CloudMachine } from "../../../data/hostedCloud";
import { fetchProviders, type ProviderInfo } from "../../../data/management";
import { cloudProviders } from "../cloudAgent";
import CloudLoginDialog from "./CloudLoginDialog";
import { EMPTY, type LoginTick, loginTick } from "./peopleWords";

/** Words for how a withdraw went: fixed here. */
export const WITHDRAW_TEXT = {
  done: "The login is gone from your cloud, and its agents are waiting for a new one.",
  waiting: "The login is gone from Switch. Your cloud is still checking; look again in a minute.",
} as const;

/** Each login's line, fixed here: "Login set" only once the box has confirmed it (PM rule 2). */
export const STATUS_TEXT: Record<LoginStatus, string> = {
  none: "No login yet",
  set: "Login set",
  waiting: "Waiting for your cloud",
  failed: "Your cloud couldn't sign in with it",
  missed: "Your cloud didn't get it in time",
};

/**
 * The AI logins on the person's box, one line per provider a box takes a
 * login for (hosted agents v2, Switch web): set or not (never any part of
 * it), Give or Change, and Withdraw. Only for the box's own controller.
 * "Login set" shows only once the box confirms it; until then the line says
 * it's waiting, and reads again every few seconds.
 */
/** The section's id: the setup checklist's and a status line's Give login bring it into view. */
export const AI_LOGINS_ID = "cloud-ai-logins";

export default function CloudLoginsSection({
  controllerId,
  machine,
  onCloudChanged,
  onLoginSet,
  onHurry,
  agentProviders = [],
  ask = null,
}: {
  /** The box's controller, from hosted-machines' `controller_id`. */
  controllerId: string;
  /** The box itself, so the login dialog knows whether it can take a login. */
  machine: CloudMachine;
  /** Read the box again, after the dialog wakes it. */
  onCloudChanged: () => void;
  /** The checklist's "AI login set" (`loginTick`), or null when the logins couldn't be read. */
  onLoginSet?: (tick: LoginTick | null) => void;
  /** The provider each of the box's agents runs (null when unknown), for `loginTick`. */
  agentProviders?: readonly (string | null)[];
  /** Open the login form for this provider: the checklist's Give login. A new
   * object each press, so pressing again reopens it. */
  ask?: { provider: string } | null;
  /** Passed to the login dialog: read the box faster while it waits. */
  onHurry?: () => () => void;
}) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [statuses, setStatuses] = useState<Map<string, LoginStatus> | null>(null);
  const [giving, setGiving] = useState<ProviderInfo | null>(null);
  const [withdrawing, setWithdrawing] = useState<ProviderInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ severity: "success" | "info" | "error"; text: string } | null>(null);

  // Leaving the page stops following a withdraw's recheck.
  const following = useRef<AbortController | null>(null);
  useEffect(() => () => following.current?.abort(), []);

  const load = useCallback(async () => {
    try {
      const [logins, operations] = await Promise.all([listCloudLogins(controllerId), listOperations(controllerId)]);
      setStatuses(new Map(logins.map((login) => [login.provider, loginStatus(login.provider, logins, operations)])));
    } catch {
      setStatuses(null);
    }
  }, [controllerId]);

  // Worked out here, where the box's logins are read; the checklist only shows
  // it. Keyed on the providers' text, so a parent's fresh array each render
  // doesn't report again and again.
  const agentsKey = JSON.stringify(agentProviders);
  const tick = useMemo(
    () =>
      statuses === null
        ? null
        : loginTick(
            JSON.parse(agentsKey) as (string | null)[],
            new Set([...statuses].filter(([, status]) => status === "set").map(([id]) => id)),
            new Set(providers.map((provider) => provider.id)),
          ),
    [agentsKey, statuses, providers],
  );
  useEffect(() => onLoginSet?.(tick), [tick, onLoginSet]);

  // The checklist's Give login: the form for the first provider missing.
  useEffect(() => {
    const provider = ask && providers.find((p) => p.id === ask.provider);
    if (provider) setGiving(provider);
  }, [ask, providers]);

  // While a login waits for the box, read again until the box says how it went.
  const anyWaiting = statuses !== null && [...statuses.values()].includes("waiting");
  useEffect(() => {
    if (!anyWaiting) return;
    const timer = window.setTimeout(() => void load(), OPERATION_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [anyWaiting, statuses, load]);

  useEffect(() => {
    let live = true;
    fetchProviders().then(
      (listed) => live && setProviders(cloudProviders(listed)),
      () => live && setProviders([]),
    );
    void load();
    return () => {
      live = false;
    };
  }, [load]);

  const withdraw = async () => {
    if (!withdrawing) return;
    setBusy(true);
    setNotice(null);
    const since = Date.now();
    following.current?.abort();
    const follow = new AbortController();
    following.current = follow;
    try {
      const { controllerId: id } = await withdrawCloudLogin(withdrawing.id);
      const state = await waitForOperation(
        id,
        { kind: "provider.recheck", provider: withdrawing.id, since },
        { signal: follow.signal },
      );
      // Closed meanwhile: the list shows where it stands (closeWithdraw reads it again).
      if (follow.signal.aborted) return;
      setNotice({ severity: state === null ? "info" : "success", text: state === null ? WITHDRAW_TEXT.waiting : WITHDRAW_TEXT.done });
      setWithdrawing(null);
      await load();
    } catch (caught) {
      setNotice({ severity: "error", text: caught instanceof Error ? caught.message : "The login couldn't be withdrawn." });
    } finally {
      // A newer withdraw, started after this one was closed, keeps its own busy.
      if (following.current === follow || following.current === null) setBusy(false);
    }
  };

  // Never disabled: closing stops only the following, and the list shows the state.
  const closeWithdraw = () => {
    following.current?.abort();
    following.current = null;
    setWithdrawing(null);
    void load();
  };

  if (providers.length === 0) return null;
  return (
    <Paper
      variant="outlined"
      sx={{ p: 2, mb: 2, "&:focus-visible": { outline: 2, outlineColor: "primary.main" } }}
      component="section"
      aria-label="AI logins on your cloud"
      id={AI_LOGINS_ID}
      tabIndex={-1}
    >
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
        AI logins on your cloud
      </Typography>
      {statuses !== null && ![...statuses.values()].some((status) => status !== "none") && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {EMPTY.noLogin}
        </Typography>
      )}
      {notice && (
        <Alert severity={notice.severity} sx={{ mb: 1 }} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}
      <Stack spacing={1}>
        {providers.map((provider) => {
          const status = statuses === null ? null : (statuses.get(provider.id) ?? "none");
          const held = status !== null && status !== "none";
          const trouble = status === "failed" || status === "missed";
          return (
            <Stack key={provider.id} direction="row" alignItems="center" spacing={1} data-testid={`login-${provider.id}`}>
              <Box sx={{ flexGrow: 1 }}>
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  {provider.label}
                </Typography>
                <Typography
                  variant="body2"
                  color={trouble ? "error" : "text.secondary"}
                  data-testid={`login-status-${provider.id}`}
                >
                  {status === null ? "Couldn't read" : STATUS_TEXT[status]}
                </Typography>
              </Box>
              <Button size="small" variant="outlined" onClick={() => setGiving(provider)}>
                {trouble ? "Try again" : held ? "Change" : "Give login"}
              </Button>
              {held && (
                <Button size="small" color="error" variant="contained" onClick={() => setWithdrawing(provider)}>
                  Withdraw
                </Button>
              )}
            </Stack>
          );
        })}
      </Stack>

      <CloudLoginDialog
        open={giving !== null}
        provider={giving?.id ?? ""}
        providerLabel={giving?.label ?? ""}
        machine={machine}
        onCloudChanged={onCloudChanged}
        onHurry={onHurry}
        onClose={() => {
          setGiving(null);
          // Closed while it waited: the line shows where the login stands.
          void load();
        }}
        onDone={() => void load()}
      />

      <Dialog open={withdrawing !== null} onClose={closeWithdraw}>
        <DialogTitle>Withdraw the {withdrawing?.label} login?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Your cloud stops using it, and its {withdrawing?.label} agents wait for a new login before they can
            answer.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeWithdraw}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={withdraw}
            disabled={busy}
            startIcon={busy ? <CircularProgress size={16} /> : undefined}
          >
            Withdraw
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
