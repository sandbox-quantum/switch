import ContentCopy from "@mui/icons-material/ContentCopy";
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  MenuItem,
  Stack,
  TextField,
} from "@mui/material";
import { useCallback, useState } from "react";
import { type ApiKeyLifetime, createApiKey } from "../../data/api";
import { formatKeyExpiry } from "./keyExpiry";

const LIFETIMES: { value: ApiKeyLifetime; label: string }[] = [
  { value: 90, label: "90 days" },
  { value: 365, label: "1 year" },
  { value: "never", label: "Never" },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export default function CreateKeyDialog({ open, onClose, onCreated }: Props) {
  const [label, setLabel] = useState("");
  const [lifetime, setLifetime] = useState<ApiKeyLifetime>(90);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; expiresAt: string | null } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  const reset = useCallback(() => {
    setLabel("");
    setLifetime(90);
    setSubmitting(false);
    setError(null);
    setResult(null);
    setCopied(false);
  }, []);

  const handleClose = useCallback(() => {
    if (result) onCreated();
    reset();
    onClose();
  }, [result, onCreated, reset, onClose]);

  const handleSubmit = useCallback(async () => {
    if (!label) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await createApiKey(label, lifetime);
      setResult({ key: res.key, expiresAt: res.expires_at });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create key.");
    } finally {
      setSubmitting(false);
    }
  }, [label, lifetime]);

  const handleCopy = useCallback(() => {
    if (!result) return;
    const text = result.key;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [result]);

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>{result ? "Key created" : "Create API key"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {result ? (
            <>
              <Alert severity="warning">
                Copy the key now. It will not be shown again.
              </Alert>
              <TextField
                label="API key"
                value={result.key}
                fullWidth
                slotProps={{
                  input: {
                    readOnly: true,
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton onClick={handleCopy} size="small" aria-label="Copy key">
                          <ContentCopy fontSize="small" />
                        </IconButton>
                      </InputAdornment>
                    ),
                  },
                }}
                helperText={
                  copied
                    ? "Copied!"
                    : result.expiresAt === null
                      ? "This key does not expire."
                      : `Expires ${formatKeyExpiry(result.expiresAt, new Date())}.`
                }
              />
            </>
          ) : (
            <>
              {error && <Alert severity="error">{error}</Alert>}
              <TextField
                label="Label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                fullWidth
                required
                placeholder="e.g. My ADK connector"
              />
              <TextField
                select
                label="Expires after"
                value={String(lifetime)}
                onChange={(e) =>
                  setLifetime(e.target.value === "never" ? "never" : Number(e.target.value))
                }
                fullWidth
              >
                {LIFETIMES.map((option) => (
                  <MenuItem key={String(option.value)} value={String(option.value)}>
                    {option.label}
                  </MenuItem>
                ))}
              </TextField>
              {lifetime === "never" && (
                <Alert severity="warning">
                  A key that never expires keeps working until you delete it,
                  including if it leaks. Choose an expiry unless something
                  depends on this key and cannot be given a new one.
                </Alert>
              )}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        {result ? (
          <Button onClick={handleClose} variant="contained">
            Done
          </Button>
        ) : (
          <>
            <Button onClick={handleClose}>Cancel</Button>
            <Button
              variant="contained"
              onClick={handleSubmit}
              disabled={submitting || !label}
              startIcon={
                submitting ? <CircularProgress size={16} /> : undefined
              }
            >
              Create
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
