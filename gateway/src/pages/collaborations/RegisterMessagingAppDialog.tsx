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
  Link,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type BridgeDetail,
  type ChatClaim,
  type InstallablePlatforms,
  beginChatClaim,
  createBridge,
  fetchInstallablePlatforms,
} from "../../data/api";
import { useBridgeTypes } from "../../data/hooks";
import {
  extractDefaults,
  isProvided,
  renderOptionFields,
} from "../agents/optionFields";
import { titleCase } from "../../theme/format";
import ClaimChatDialog from "./ClaimChatDialog";
import OfficialAppInstall from "./OfficialAppInstall";

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
  // This server's own apps, which add in one click, offered before
  // connecting an app of one's own, as Console offers them.
  const [offered, setOffered] = useState<InstallablePlatforms | null>(null);
  const [offeredError, setOfferedError] = useState<string | null>(null);
  const [useOwnApp, setUseOwnApp] = useState(false);
  const [claim, setClaim] = useState<{ platform: string; claim: ChatClaim } | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setOffered(null);
    setOfferedError(null);
    fetchInstallablePlatforms()
      .then((found) => {
        if (live) setOffered(found);
      })
      .catch((caught: unknown) => {
        if (live)
          setOfferedError(
            `Could not check which messaging apps Switch can add for you, so only connecting your own app is offered. (${caught instanceof Error ? caught.message : String(caught)})`,
          );
      });
    return () => {
      live = false;
    };
  }, [open]);

  const forThisOne = (platform: string) => !initialType || platform === initialType;
  const installable = (offered ? [...offered] : []).filter(forThisOne);
  const claimable = (offered?.claimable ?? []).filter(
    (each) => each.can_add_chat && forThisOne(each.platform),
  );
  const offerInstall = (installable.length > 0 || claimable.length > 0) && !useOwnApp;
  const checking = open && offered === null && offeredError === null;

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
    setUseOwnApp(false);
    setClaim(null);
    setClaimError(null);
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

  const installed = useCallback(
    (bridge: BridgeDetail) => {
      onSuccess(bridge);
      reset();
      onClose();
    },
    [onSuccess, reset, onClose],
  );

  const startClaim = async (platform: string) => {
    setClaimError(null);
    try {
      setClaim({ platform, claim: await beginChatClaim(platform) });
    } catch (caught) {
      setClaimError(caught instanceof Error ? caught.message : "Could not start connecting a chat.");
    }
  };

  if (offerInstall || checking)
    return (
      <>
        <Dialog open={open && claim === null} onClose={handleClose} maxWidth="sm" fullWidth>
          <DialogTitle>Add messaging app</DialogTitle>
          <DialogContent>
            <Stack spacing={3} sx={{ mt: 1 }}>
              {checking ? (
                <CircularProgress size={20} />
              ) : (
                <>
                  {installable.map((platform) => (
                    <OfficialAppInstall key={platform} platform={platform} onInstalled={installed} />
                  ))}
                  {claimable.map((each) => (
                    <Stack key={each.platform} spacing={1} alignItems="flex-start">
                      <Typography variant="body2" color="text.secondary">
                        Adds Switch's own {titleCase(each.platform)} bot to a chat of yours.
                      </Typography>
                      <Button variant="contained" onClick={() => void startClaim(each.platform)}>
                        Add to {titleCase(each.platform)}
                      </Button>
                    </Stack>
                  ))}
                  {claimError && <Alert severity="error">{claimError}</Alert>}
                  <Link
                    component="button"
                    variant="body2"
                    sx={{ alignSelf: "flex-start" }}
                    onClick={() => setUseOwnApp(true)}
                  >
                    Use your own app instead
                  </Link>
                </>
              )}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={handleClose}>Cancel</Button>
          </DialogActions>
        </Dialog>
        <ClaimChatDialog
          platform={claim?.platform ?? ""}
          claim={claim?.claim ?? null}
          onClose={() => {
            // The chat is connected from the platform, so this ends here; the
            // caller reads its connections again on closing.
            reset();
            onClose();
          }}
        />
      </>
    );

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add messaging app</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          {offeredError && <Alert severity="warning">{offeredError}</Alert>}
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
