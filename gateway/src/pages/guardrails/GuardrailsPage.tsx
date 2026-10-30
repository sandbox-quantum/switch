import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  type TrustSettings,
  clearTrustSettings,
  fetchTrustSettings,
  updateTrustSettings,
} from "../../data/api";

type Form = { endpoint: string; policyId: string; apiKey: string };

function formFor(settings: TrustSettings): Form {
  return { endpoint: settings.endpoint, policyId: settings.policy_id ?? "", apiKey: "" };
}

function failure(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 403) {
    return "Only the platform operator can view or change the guardrails settings.";
  }
  return err instanceof Error ? err.message : fallback;
}

/**
 * Switch Trust, the deployment's guardrails: once an endpoint, a policy and an
 * API key are set, every message the server sends is checked before it goes
 * out. One policy covers the whole deployment, so this is the platform
 * operator's, not a workspace admin's. The stored key is never shown; leaving
 * the field blank keeps it.
 */
export default function GuardrailsPage() {
  const [settings, setSettings] = useState<TrustSettings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [clearing, setClearing] = useState(false);

  const show = useCallback((next: TrustSettings) => {
    setSettings(next);
    setForm(formFor(next));
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchTrustSettings().then(
      (loaded) => !cancelled && show(loaded),
      (err: unknown) =>
        !cancelled && setLoadError(failure(err, "Could not load the guardrails settings.")),
    );
    return () => {
      cancelled = true;
    };
  }, [show]);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setActionError(null);
    try {
      const apiKey = form.apiKey.trim();
      show(
        await updateTrustSettings({
          endpoint: form.endpoint.trim(),
          policy_id: form.policyId.trim() === "" ? null : form.policyId.trim(),
          ...(apiKey === "" ? {} : { api_key: apiKey }),
        }),
      );
    } catch (err) {
      setActionError(failure(err, "Could not save the guardrails settings."));
    } finally {
      setSaving(false);
    }
  };

  const turnOff = async () => {
    setClearing(true);
    setActionError(null);
    try {
      show(await clearTrustSettings());
      setConfirmingOff(false);
    } catch (err) {
      setActionError(failure(err, "Could not turn the guardrails off."));
    } finally {
      setClearing(false);
    }
  };

  return (
    <Box>
      <Box mb={2}>
        <Typography variant="h5">Guardrails</Typography>
        <Typography variant="body2" color="text.secondary">
          Switch Trust checks every message this server sends before it goes out, once an
          endpoint, a policy and an API key are set. One policy covers every workspace.
        </Typography>
      </Box>
      {loadError && <Alert severity="error">{loadError}</Alert>}
      {!loadError && (!settings || !form) && <CircularProgress />}
      {settings && form && (
        <Paper variant="outlined" sx={{ p: 2, maxWidth: 640 }}>
          <Stack spacing={2}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="subtitle1">Switch Trust</Typography>
              <Chip
                size="small"
                label={settings.enabled ? "Checking messages" : "Not checking messages"}
                color={settings.enabled ? "success" : "default"}
              />
            </Stack>
            <TextField
              label="API key"
              type="password"
              autoComplete="new-password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder={settings.has_api_key ? "Leave blank to keep the current key" : ""}
              error={settings.has_api_key && settings.api_key_last4 === null}
              helperText={
                !settings.has_api_key
                  ? "No key set."
                  : settings.api_key_last4 !== null
                    ? `A key ending ${settings.api_key_last4} is set.`
                    : "A key is set but can no longer be read. Save a new key to replace it."
              }
              fullWidth
            />
            <TextField
              label="Guardrails policy ID"
              value={form.policyId}
              onChange={(e) => setForm({ ...form, policyId: e.target.value })}
              autoComplete="off"
              fullWidth
            />
            <TextField
              label="Switch Trust endpoint"
              value={form.endpoint}
              onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
              autoComplete="off"
              required
              fullWidth
            />
            {actionError && (
              <Alert severity="error" onClose={() => setActionError(null)}>
                {actionError}
              </Alert>
            )}
            <Stack direction="row" spacing={1} alignItems="center">
              <Button
                variant="contained"
                onClick={() => void save()}
                disabled={form.endpoint.trim() === "" || saving || clearing}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
              {settings.has_api_key && !confirmingOff && (
                <Button
                  variant="outlined"
                  disabled={saving || clearing}
                  onClick={() => setConfirmingOff(true)}
                >
                  Turn off
                </Button>
              )}
              {confirmingOff && (
                <>
                  <Typography variant="body2" color="text.secondary">
                    Turn off Switch Trust? Messages stop being checked.
                  </Typography>
                  <Button
                    color="error"
                    variant="contained"
                    disabled={clearing}
                    onClick={() => void turnOff()}
                  >
                    {clearing ? "Turning off…" : "Turn off"}
                  </Button>
                  <Button disabled={clearing} onClick={() => setConfirmingOff(false)}>
                    Cancel
                  </Button>
                </>
              )}
            </Stack>
          </Stack>
        </Paper>
      )}
    </Box>
  );
}
