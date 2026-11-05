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
import { useCallback, useEffect, useRef, useState } from "react";
import { type CloudLogin, listCloudLogins, waitForOperation, withdrawCloudLogin } from "../../../data/cloudLogins";
import { fetchProviders, type ProviderInfo } from "../../../data/management";
import { cloudProviders } from "../cloudAgent";
import CloudLoginDialog from "./CloudLoginDialog";

/** Words for how a withdraw went: fixed here. */
export const WITHDRAW_TEXT = {
  done: "The login is gone from your cloud, and its agents are waiting for a new one.",
  waiting: "The login is gone from Switch. Your cloud is still checking; look again in a minute.",
} as const;

/**
 * The AI logins on the person's box, one line per provider a box takes a
 * login for (hosted agents v2, Switch web): set or not (never any part of
 * it), Give or Change, and Withdraw. Only for the box's own controller.
 */
export default function CloudLoginsSection({
  controllerId,
  askFor,
  onAsked,
}: {
  /** The box's controller, from hosted-machines' `controller_id`. */
  controllerId: string;
  /** A provider to ask a login for straight away (a cloud agent just made), or null. */
  askFor: string | null;
  onAsked: () => void;
}) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [logins, setLogins] = useState<CloudLogin[] | null>(null);
  const [giving, setGiving] = useState<ProviderInfo | null>(null);
  const [withdrawing, setWithdrawing] = useState<ProviderInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ severity: "success" | "info" | "error"; text: string } | null>(null);

  // Leaving the page stops following a withdraw's recheck.
  const following = useRef<AbortController | null>(null);
  useEffect(() => () => following.current?.abort(), []);

  const load = useCallback(async () => {
    try {
      setLogins(await listCloudLogins(controllerId));
    } catch {
      setLogins(null);
    }
  }, [controllerId]);

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

  useEffect(() => {
    if (!askFor) return;
    const provider = providers.find((p) => p.id === askFor);
    if (provider) {
      setGiving(provider);
      onAsked();
    }
  }, [askFor, providers, onAsked]);

  const withdraw = async () => {
    if (!withdrawing) return;
    setBusy(true);
    setNotice(null);
    const since = Date.now();
    try {
      const { controllerId: id } = await withdrawCloudLogin(withdrawing.id);
      const follow = new AbortController();
      following.current = follow;
      const state = await waitForOperation(
        id,
        { kind: "provider.recheck", provider: withdrawing.id, since },
        { signal: follow.signal },
      );
      if (follow.signal.aborted) return;
      setNotice({ severity: state === null ? "info" : "success", text: state === null ? WITHDRAW_TEXT.waiting : WITHDRAW_TEXT.done });
      setWithdrawing(null);
      await load();
    } catch (caught) {
      setNotice({ severity: "error", text: caught instanceof Error ? caught.message : "The login couldn't be withdrawn." });
    } finally {
      setBusy(false);
    }
  };

  if (providers.length === 0) return null;
  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }} component="section" aria-label="AI logins on your cloud">
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
        AI logins on your cloud
      </Typography>
      {notice && (
        <Alert severity={notice.severity} sx={{ mb: 1 }} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}
      <Stack spacing={1}>
        {providers.map((provider) => {
          const login = logins?.find((l) => l.provider === provider.id) ?? null;
          return (
            <Stack key={provider.id} direction="row" alignItems="center" spacing={1} data-testid={`login-${provider.id}`}>
              <Box sx={{ flexGrow: 1 }}>
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  {provider.label}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {logins === null ? "Couldn't read" : login ? "Login set" : "No login yet"}
                </Typography>
              </Box>
              <Button size="small" variant="outlined" onClick={() => setGiving(provider)}>
                {login ? "Change" : "Give login"}
              </Button>
              {login && (
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
        onClose={() => setGiving(null)}
        onDone={() => void load()}
      />

      <Dialog open={withdrawing !== null} onClose={busy ? undefined : () => setWithdrawing(null)}>
        <DialogTitle>Withdraw the {withdrawing?.label} login?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Your cloud stops using it, and its {withdrawing?.label} agents wait for a new login before they can
            answer.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setWithdrawing(null)} disabled={busy}>
            Cancel
          </Button>
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
