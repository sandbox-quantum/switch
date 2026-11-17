import {
  Alert,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type BridgeDetail, createBridge } from "../../data/api";
import { useBridgeTypes } from "../../data/hooks";
import {
  extractDefaults,
  isProvided,
  renderOptionFields,
} from "../agents/optionFields";

interface Props {
  open: boolean;
  /** The messaging app to open on, as its bridge type; "" to let the person pick. */
  initialType: string;
  onClose: () => void;
  onSuccess: (bridge: BridgeDetail) => void;
}

function humanize(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function RegisterMessagingAppDialog({
  open,
  initialType,
  onClose,
  onSuccess,
}: Props) {
  const { data: bridgeTypes, error: typesError } = useBridgeTypes();
  const [selectedType, setSelectedType] = useState("");
  const [displayName, setDisplayName] = useState("");
  // Values are typed by the schema, not all strings: a boolean field must post
  // a real boolean, since the backend rejects "" as one.
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [channelCreationEnabled, setChannelCreationEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedTypeInfo = useMemo(
    () => bridgeTypes?.find((t) => t.key === selectedType),
    [bridgeTypes, selectedType],
  );
  const configSchema = selectedTypeInfo?.config_schema;
  // Unknown until the type list has loaded; assume supported so the checkbox
  // isn't forced off while that request is in flight.
  const channelCreationSupported = selectedTypeInfo?.channel_creation_supported ?? true;

  const handleTypeChange = useCallback(
    (key: string) => {
      // Switching type clears any fields entered for the previous one, then
      // seeds the new type's defaults — a field left untouched should post what
      // the schema says it defaults to, not an empty value.
      setSelectedType(key);
      const schema = bridgeTypes?.find((t) => t.key === key)?.config_schema;
      setConfig(extractDefaults(schema as Record<string, unknown> | undefined));
      setChannelCreationEnabled(true);
      setError(null);
    },
    [bridgeTypes],
  );

  // Opened for one app, it starts on that app's form once the types are known.
  useEffect(() => {
    if (open && initialType && bridgeTypes?.some((t) => t.key === initialType))
      handleTypeChange(initialType);
  }, [open, initialType, bridgeTypes, handleTypeChange]);

  const reset = useCallback(() => {
    setSelectedType("");
    setDisplayName("");
    setConfig({});
    setChannelCreationEnabled(true);
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    if (submitting) return;
    reset();
    onClose();
  }, [submitting, reset, onClose]);

  const requiredFields = configSchema?.required ?? [];
  const canSubmit =
    !!selectedType &&
    displayName.trim().length > 0 &&
    requiredFields.every((f) => isProvided(config[f]));

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const bridge = await createBridge(
        selectedType,
        displayName.trim(),
        config,
        channelCreationSupported && channelCreationEnabled,
      );
      onSuccess(bridge);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed.");
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit,
    selectedType,
    displayName,
    config,
    channelCreationSupported,
    channelCreationEnabled,
    onSuccess,
    reset,
    onClose,
  ]);

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add messaging app</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          {typesError && (
            <Alert severity="error">Couldn't load the messaging platforms Switch connects to: {typesError}</Alert>
          )}

          <TextField
            select
            label="Type"
            value={selectedType}
            onChange={(e) => handleTypeChange(e.target.value)}
            fullWidth
            required
            helperText="The messaging platform to bridge."
          >
            {(bridgeTypes ?? []).map((t) => (
              <MenuItem
                key={t.key}
                value={t.key}
                sx={{ textTransform: "capitalize" }}
              >
                {t.key}
              </MenuItem>
            ))}
          </TextField>

          {selectedType && (
            <>
              <TextField
                label="Display name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                fullWidth
                required
              />
              <Stack spacing={0.5}>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={channelCreationSupported && channelCreationEnabled}
                      disabled={!channelCreationSupported}
                      onChange={(e) => setChannelCreationEnabled(e.target.checked)}
                    />
                  }
                  label="Allow creating channels from Switch"
                />
                {!channelCreationSupported && (
                  <Typography variant="caption" color="text.secondary">
                    {humanize(selectedType)} has no way to create channels from
                    Switch, so this messaging app can only be used with existing
                    channels.
                  </Typography>
                )}
              </Stack>
              {renderOptionFields(
                configSchema as Record<string, unknown> | undefined,
                config,
                setConfig,
                requiredFields,
              )}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={!canSubmit || submitting}
          startIcon={submitting ? <CircularProgress size={16} /> : undefined}
        >
          Add
        </Button>
      </DialogActions>
    </Dialog>
  );
}
