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
  ListSubheader,
  MenuItem,
  Stack,
  TextField,
} from "@mui/material";
import { useCallback, useState } from "react";
import {
  type KnownAgentType,
  type RegisterResult,
  registerKnownAgent,
  registerOtherAgent,
} from "../../data/api";
import { useKnownAgentTypes } from "../../data/hooks";
import { extractDefaults, renderOptionFields } from "./optionFields";

interface Props {
  open: boolean;
  onClose: () => void;
  onRegistered: () => void;
}

type SelectedKind = "known" | "other" | null;

const OTHER_KEY = "__other__";

export default function RegisterAgentDialog({
  open,
  onClose,
  onRegistered,
}: Props) {
  const { data: knownTypes } = useKnownAgentTypes();

  const [selectedKey, setSelectedKey] = useState("");
  const [selectedKind, setSelectedKind] = useState<SelectedKind>(null);

  // Known agent / Other fields
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  // Known-agent type-specific options
  const [knownAgentOptions, setKnownAgentOptions] = useState<
    Record<string, unknown>
  >({});

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentResult, setAgentResult] = useState<RegisterResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const hasResult = agentResult !== null;

  const reset = useCallback(() => {
    setSelectedKey("");
    setSelectedKind(null);
    setName("");
    setDescription("");
    setKnownAgentOptions({});
    setSubmitting(false);
    setError(null);
    setAgentResult(null);
    setCopied(null);
  }, []);

  const handleClose = useCallback(() => {
    if (hasResult) onRegistered();
    reset();
    onClose();
  }, [hasResult, onRegistered, reset, onClose]);

  const handleTypeChange = useCallback(
    (value: string) => {
      setSelectedKey(value);
      const kind: SelectedKind = value === OTHER_KEY ? "other" : "known";
      setSelectedKind(kind);

      // Seed type-specific options with their schema defaults so unchecking a
      // box explicitly sets `false` rather than dropping the field.
      if (kind === "known") {
        const spec = knownTypes?.find((t) => t.key === value);
        setKnownAgentOptions(extractDefaults(spec?.options_schema));
      } else {
        setKnownAgentOptions({});
      }
    },
    [knownTypes],
  );

  const canSubmit =
    selectedKind === "known"
      ? selectedKey && name
      : selectedKind === "other"
        ? name
        : false;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      if (selectedKind === "known") {
        const res = await registerKnownAgent(
          selectedKey,
          name,
          description,
          knownAgentOptions,
        );
        setAgentResult(res);
      } else if (selectedKind === "other") {
        const res = await registerOtherAgent(name, description);
        setAgentResult(res);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed.");
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit,
    selectedKind,
    selectedKey,
    name,
    description,
    knownAgentOptions,
  ]);

  const handleCopy = useCallback((value: string, label: string) => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value);
    } else {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  const selectedType = knownTypes?.find(
    (t: KnownAgentType) => t.key === selectedKey,
  );

  const hasKnown = knownTypes && knownTypes.length > 0;

  const copyAdornment = (value: string, label: string) => (
    <InputAdornment position="end">
      <IconButton onClick={() => handleCopy(value, label)} size="small">
        <ContentCopy fontSize="small" />
      </IconButton>
    </InputAdornment>
  );

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {hasResult ? "Registration Complete" : "Register Agent"}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {agentResult ? (
            <>
              <Alert severity="warning">
                Copy these credentials now. They will not be shown again.
              </Alert>
              <TextField
                label="API Key"
                value={agentResult.api_key}
                fullWidth
                slotProps={{
                  input: {
                    readOnly: true,
                    endAdornment: copyAdornment(agentResult.api_key, "API Key"),
                  },
                }}
                helperText={copied === "API Key" ? "Copied!" : undefined}
              />
              <TextField
                label="Agent ID"
                value={agentResult.id}
                fullWidth
                slotProps={{ input: { readOnly: true } }}
              />
              {agentResult.oauth_client_id && (
                <TextField
                  label="OAuth Client ID"
                  value={agentResult.oauth_client_id}
                  fullWidth
                  slotProps={{
                    input: {
                      readOnly: true,
                      endAdornment: copyAdornment(agentResult.oauth_client_id, "OAuth Client ID"),
                    },
                  }}
                  helperText={copied === "OAuth Client ID" ? "Copied!" : undefined}
                />
              )}
              {agentResult.oauth_client_secret && (
                <TextField
                  label="OAuth Client Secret"
                  value={agentResult.oauth_client_secret}
                  fullWidth
                  slotProps={{
                    input: {
                      readOnly: true,
                      endAdornment: copyAdornment(agentResult.oauth_client_secret, "OAuth Client Secret"),
                    },
                  }}
                  helperText={copied === "OAuth Client Secret" ? "Copied!" : undefined}
                />
              )}
            </>
          ) : (
            <>
              {error && <Alert severity="error">{error}</Alert>}
              <TextField
                select
                label="Type"
                value={selectedKey}
                onChange={(e) => handleTypeChange(e.target.value)}
                fullWidth
                required
                helperText={
                  selectedType
                    ? `${selectedType.connector_type} / ${selectedType.tool_count} tools`
                    : undefined
                }
              >
                {hasKnown && (
                  <ListSubheader>Known Agents</ListSubheader>
                )}
                {(knownTypes ?? []).map((t: KnownAgentType) => (
                  <MenuItem key={t.key} value={t.key}>
                    {t.key}
                  </MenuItem>
                ))}
                <ListSubheader>Other</ListSubheader>
                <MenuItem value={OTHER_KEY}>
                  External agent
                </MenuItem>
              </TextField>

              {(selectedKind === "known" || selectedKind === "other") && (
                <>
                  <TextField
                    label="Name"
                    value={name}
                    onChange={(e) => setName(e.target.value.replace(/[A-Z]/g, (c) => c.toLowerCase()))}
                    fullWidth
                    required
                  />
                  <TextField
                    label="Description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    fullWidth
                    multiline
                    rows={2}
                  />
                  {selectedKind === "known" &&
                    selectedType &&
                    renderOptionFields(
                      selectedType.options_schema,
                      knownAgentOptions,
                      setKnownAgentOptions,
                    )}
                </>
              )}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        {hasResult ? (
          <Button onClick={handleClose} variant="contained">
            Done
          </Button>
        ) : (
          <>
            <Button onClick={handleClose}>Cancel</Button>
            <Button
              variant="contained"
              onClick={handleSubmit}
              disabled={submitting || !canSubmit}
              startIcon={
                submitting ? <CircularProgress size={16} /> : undefined
              }
            >
              Register
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}

