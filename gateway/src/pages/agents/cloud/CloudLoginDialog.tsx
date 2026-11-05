import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { giveCloudLogin, waitForOperation } from "../../../data/cloudLogins";
import { SealRefused, canSeal } from "../../../data/sealLogin";
import { VertexKeyRefused, vertexCredential } from "../../../data/vertexLogin";
import { BOX_LOGINS } from "../cloudAgent";

type Kind = "api-key" | "setup-token" | "vertex";

const KIND_LABEL: Record<Kind, string> = {
  "setup-token": "Setup token",
  "api-key": "API key",
  vertex: "Vertex AI (service account key file)",
};

/** Words for each way a login can go, fixed here: never the box's or the provider's own text. */
export const OUTCOME_TEXT = {
  succeeded: "Your cloud signed in with it.",
  failed: "Your cloud couldn't sign in with that login. Check it and try again.",
  waiting: "Your cloud has the login and is still checking it. Look again in a minute.",
} as const;

/**
 * Give the person's box an AI login for `provider`, or a new one in place of
 * the old (hosted agents v2, Switch web). The login is sealed in this page to
 * the box's own controller key and only the sealed blob is sent
 * (`giveCloudLogin`). Inputs are read once, on Give, straight from the fields,
 * and cleared after: the key file and the typed key never sit in React state,
 * storage or the URL, and nothing logs them. Switch Console is the stronger
 * place to add a login, as the dialog says (security).
 */
export default function CloudLoginDialog({
  open,
  provider,
  providerLabel,
  onClose,
  onDone,
}: {
  open: boolean;
  provider: string;
  providerLabel: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const kinds = (BOX_LOGINS[provider] ?? []) as Kind[];
  const [kind, setKind] = useState<Kind>(kinds[0] ?? "api-key");
  const [project, setProject] = useState("");
  const [region, setRegion] = useState("global");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [sealable, setSealable] = useState<boolean | null>(null);
  const following = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const secretInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setKind(kinds[0] ?? "api-key");
    setProject("");
    setRegion("global");
    setError(null);
    setOutcome(null);
    let live = true;
    void canSeal().then((can) => live && setSealable(can));
    return () => {
      live = false;
      // Closing the dialog stops following how the box took the login.
      following.current?.abort();
      following.current = null;
    };
    // Reset when it opens or the provider changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider]);

  const clearInputs = () => {
    if (fileInput.current) fileInput.current.value = "";
    if (secretInput.current) secretInput.current.value = "";
  };

  const give = async () => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      let credential: string;
      if (kind === "vertex") {
        const file = fileInput.current?.files?.[0];
        if (!file) throw new VertexKeyRefused("not_json");
        // Read as bytes, which `vertexCredential` zero-fills whatever happens.
        credential = vertexCredential(new Uint8Array(await file.arrayBuffer()), project, region);
      } else {
        credential = secretInput.current?.value.trim() ?? "";
        if (!credential) throw new SealRefused("bad_login");
      }
      const { controllerId, operation } = await giveCloudLogin(provider, { kind, credential });
      credential = "";
      clearInputs();
      following.current?.abort();
      const follow = new AbortController();
      following.current = follow;
      const state = await waitForOperation(controllerId, { id: operation.id }, { signal: follow.signal });
      // Closed meanwhile: no outcome to show, but the list still reads again.
      if (!follow.signal.aborted)
        setOutcome(
          state === "succeeded" ? OUTCOME_TEXT.succeeded : state === null ? OUTCOME_TEXT.waiting : OUTCOME_TEXT.failed,
        );
      onDone();
    } catch (caught) {
      clearInputs();
      setError(
        caught instanceof SealRefused || caught instanceof VertexKeyRefused
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : "The login couldn't be given.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{providerLabel} login for your cloud</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Alert severity="info">
            Your login is locked to your cloud in this page before it's sent, so Switch only ever holds
            the locked copy. Switch Console is the stronger place to add it, because its locking code
            comes with the app rather than with each page load.
          </Alert>
          {sealable === false && (
            <Alert severity="warning">This browser can't lock a login. Use Switch Console to add it.</Alert>
          )}
          {error && <Alert severity="error">{error}</Alert>}
          {outcome && <Alert severity={outcome === OUTCOME_TEXT.succeeded ? "success" : "info"}>{outcome}</Alert>}
          <TextField
            select
            label="Login"
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
            disabled={busy}
          >
            {kinds.map((k) => (
              <MenuItem key={k} value={k}>
                {KIND_LABEL[k]}
              </MenuItem>
            ))}
          </TextField>
          {kind === "vertex" ? (
            <>
              <Typography variant="body2" color="text.secondary">
                Choose the JSON key file of a service account that can use only Vertex AI
                (roles/aiplatform.user). A Google sign-in file isn't accepted here; use Switch Console for that.
              </Typography>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                aria-label="Service account key file"
                disabled={busy}
              />
              <TextField
                label="Google Cloud project"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                disabled={busy}
                required
              />
              <TextField
                label="Region"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                disabled={busy}
                helperText="global, or a region such as us-east5."
              />
            </>
          ) : (
            <TextField
              inputRef={secretInput}
              type="password"
              label={KIND_LABEL[kind]}
              autoComplete="new-password"
              disabled={busy}
              helperText={
                kind === "setup-token"
                  ? "Run `claude setup-token` on any computer signed in to Claude, and paste the token it prints."
                  : `Paste a ${providerLabel} API key.`
              }
              slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: "off", "data-1p-ignore": true } }}
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Close
        </Button>
        <Button
          variant="contained"
          onClick={give}
          disabled={busy || sealable === false || kinds.length === 0}
          startIcon={busy ? <CircularProgress size={16} /> : undefined}
        >
          Give login
        </Button>
      </DialogActions>
    </Dialog>
  );
}
