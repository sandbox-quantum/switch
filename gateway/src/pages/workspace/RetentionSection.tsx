import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useState } from "react";
import {
  MAX_MESSAGE_RETENTION_DAYS,
  clearRetentionPolicy,
  fetchRetentionPolicy,
  previewRetentionPolicy,
  setRetentionPolicy,
} from "../../data/api";
import { parseBound } from "../usage/usageFormat";
import { useLoad } from "./useLoad";

const PRESET_DAYS = [30, 90, 365];
const CUSTOM = "custom";

type Mode = "forever" | "window";

export function describeRetention(days: number | null): string {
  if (days === null) return "Messages are kept forever.";
  return `Messages older than ${days} ${days === 1 ? "day" : "days"} are deleted.`;
}

export default function RetentionSection({ tenantId }: { tenantId: string }) {
  const load = useCallback(() => fetchRetentionPolicy(tenantId), [tenantId]);
  const { data: policy, error, loading, refetch } = useLoad(load);
  const current = policy?.message_retention_days ?? null;

  const [mode, setMode] = useState<Mode>("forever");
  const [preset, setPreset] = useState<string>("90");
  const [customDays, setCustomDays] = useState("");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ days: number; count: number } | null>(null);

  const resetToCurrent = useCallback(() => {
    if (current === null) {
      setMode("forever");
      setPreset("90");
      setCustomDays("");
    } else {
      setMode("window");
      const isPreset = PRESET_DAYS.includes(current);
      setPreset(isPreset ? String(current) : CUSTOM);
      setCustomDays(isPreset ? "" : String(current));
    }
  }, [current]);

  useEffect(() => {
    resetToCurrent();
  }, [resetToCurrent]);

  const chosenDays =
    mode === "forever"
      ? null
      : preset === CUSTOM
        ? parseBound(customDays, MAX_MESSAGE_RETENTION_DAYS)
        : Number(preset);
  const invalid = mode === "window" && chosenDays === null;
  const unchanged = !invalid && chosenDays === current;

  const save = async () => {
    setActionError(null);
    setSaving(true);
    try {
      if (chosenDays === null) {
        await clearRetentionPolicy(tenantId);
        await refetch();
      } else {
        const preview = await previewRetentionPolicy(tenantId, chosenDays);
        setConfirm({ days: chosenDays, count: preview.messages_to_delete });
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not save the retention policy");
    } finally {
      setSaving(false);
    }
  };

  const applyConfirmed = async () => {
    if (!confirm) return;
    setActionError(null);
    setSaving(true);
    try {
      await setRetentionPolicy(tenantId, confirm.days);
      setConfirm(null);
      await refetch();
    } catch (err) {
      setConfirm(null);
      setActionError(err instanceof Error ? err.message : "Could not save the retention policy");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">Data retention</Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {actionError && (
        <Alert severity="error" onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      {loading ? (
        <CircularProgress />
      ) : error ? null : (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={2}>
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {describeRetention(current)} This applies to every room in the workspace,
              archived rooms included. A message&apos;s files are deleted about a day after the
              last message using them. Copies already posted to Slack or other connected chat
              apps are not affected.
            </Typography>
            <RadioGroup
              value={mode}
              onChange={(event) => setMode(event.target.value as Mode)}
            >
              <FormControlLabel value="forever" control={<Radio />} label="Keep forever" />
              <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap">
                <FormControlLabel
                  value="window"
                  control={<Radio />}
                  label="Delete messages older than"
                  sx={{ mr: 0 }}
                />
                <TextField
                  select
                  size="small"
                  value={preset}
                  disabled={mode !== "window"}
                  onChange={(event) => setPreset(event.target.value)}
                  sx={{ minWidth: 140 }}
                  inputProps={{ "aria-label": "Retention window" }}
                >
                  {PRESET_DAYS.map((days) => (
                    <MenuItem key={days} value={String(days)}>
                      {days} days
                    </MenuItem>
                  ))}
                  <MenuItem value={CUSTOM}>Custom…</MenuItem>
                </TextField>
                {preset === CUSTOM && (
                  <TextField
                    size="small"
                    label="Days"
                    value={customDays}
                    disabled={mode !== "window"}
                    onChange={(event) => setCustomDays(event.target.value)}
                    error={mode === "window" && invalid && customDays !== ""}
                    helperText={`1 to ${MAX_MESSAGE_RETENTION_DAYS}`}
                    sx={{ width: 120 }}
                  />
                )}
              </Stack>
            </RadioGroup>
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button disabled={unchanged || saving} onClick={resetToCurrent}>
                Cancel
              </Button>
              <Button
                variant="contained"
                disabled={unchanged || invalid || saving}
                onClick={() => void save()}
              >
                Save
              </Button>
            </Stack>
          </Stack>
        </Paper>
      )}
      <Dialog open={confirm !== null} onClose={() => setConfirm(null)}>
        <DialogTitle>Delete messages older than {confirm?.days} days?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirm?.count === 0
              ? "No messages are old enough to be deleted yet."
              : `${confirm?.count.toLocaleString()} ${confirm?.count === 1 ? "message" : "messages"} will be permanently deleted over the coming hours, starting within the hour. Their files follow about a day later.`}{" "}
            From then on, messages are deleted as they pass {confirm?.days} days old. Deleted
            messages cannot be recovered.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            disabled={saving}
            onClick={() => void applyConfirmed()}
          >
            Turn on retention
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
