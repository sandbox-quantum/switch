import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Link,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import {
  type ConnectorApp,
  type ConnectorAppField,
  type ConnectorAppImpact,
  ConnectorAppRefusal,
  fetchConnectorAppImpact,
  type SavedConnectorApp,
  saveConnectorApp,
} from "../../data/api";
import {
  type Audience,
  asksWhoConnects,
  confirmBeforeCheck,
  peopleIn,
  type SecretField,
  secretFields,
  setupInstructions,
  switchWarning,
  vendorName,
} from "./connectorApps";
import { useConnectorAppScope } from "./scope";

export type SetupMode = "set_up" | "switch" | "enter_again";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function Copyable({ value }: { value: string }) {
  return (
    <Stack direction="row" alignItems="center" spacing={0.5}>
      <Typography
        variant="body1"
        sx={{ fontFamily: "monospace", wordBreak: "break-all", flexGrow: 1 }}
      >
        {value}
      </Typography>
      <Tooltip title="Copy">
        <IconButton
          size="small"
          aria-label={`Copy ${value}`}
          onClick={() => void navigator.clipboard?.writeText(value)}
        >
          <ContentCopyOutlined fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

/**
 * The secret inputs, labelled as the vendor labels them: empty, masked, and
 * a private key read from its file in the browser and never shown.
 */
export function SecretInputs({
  fields,
  values,
  onChange,
  highlighted,
}: {
  fields: SecretField[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  highlighted: ConnectorAppField | null;
}) {
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  return (
    <>
      {fields.map((field) =>
        field.file ? (
          <Box key={field.name}>
            <Button variant="outlined" component="label" color={highlighted === field.name ? "error" : "primary"}>
              {fileNames[field.name] ? `${field.label}: ${fileNames[field.name]}` : `Choose the ${field.label.toLowerCase()} (.pem)`}
              <input
                hidden
                type="file"
                accept=".pem"
                aria-label={field.label}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  void file.text().then((text) => {
                    setFileNames((names) => ({ ...names, [field.name]: file.name }));
                    onChange(field.name, text);
                  });
                }}
              />
            </Button>
            <Typography variant="caption" color="text.secondary" display="block">
              Read here in your browser and sent only to Switch; never shown.
            </Typography>
          </Box>
        ) : (
          <TextField
            key={field.name}
            label={field.label}
            type="password"
            autoComplete="off"
            value={values[field.name] ?? ""}
            error={highlighted === field.name}
            onChange={(event) => onChange(field.name, event.target.value)}
          />
        ),
      )}
    </>
  );
}

/**
 * Setting up an app, entering it again, or switching to a different one:
 * create it at the vendor, paste its values, and check and save in one
 * click. Switching starts with what it does to the people connected.
 */
export default function SetupDialog({
  app,
  publicUrl,
  mode,
  open,
  onClose,
  onSaved,
}: {
  app: ConnectorApp;
  publicUrl: string | null;
  mode: SetupMode;
  open: boolean;
  onClose: () => void;
  onSaved: (saved: SavedConnectorApp) => void;
}) {
  const scope = useConnectorAppScope();
  const first = mode === "switch" ? 0 : 1;
  const [step, setStep] = useState(first);
  const [audience, setAudience] = useState<Audience>("internal");
  const [clientId, setClientId] = useState(mode === "enter_again" ? (app.saved_client_id ?? "") : "");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState<ConnectorAppField | null>(null);
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState<ConnectorAppImpact | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep(first);
    setConfirmed(false);
    setClientId(mode === "enter_again" ? (app.saved_client_id ?? "") : "");
    setSecrets({});
    setError(null);
    setField(null);
    setImpact(null);
  }, [open, first, mode, app.saved_client_id]);

  const fields = secretFields(app);
  const confirmation = confirmBeforeCheck(app);
  const complete =
    clientId.trim() !== "" &&
    fields.every((f) => (secrets[f.name] ?? "") !== "") &&
    (confirmation === null || confirmed);
  const replacing = app.saved_client_id !== null && clientId.trim() !== app.saved_client_id;
  // An organization taking its own app over from the server's moves everyone
  // connected through that, as switching does.
  const movesPeople = mode === "switch" || (mode === "set_up" && app.server_app === true);

  const save = async () => {
    setBusy(true);
    setError(null);
    setField(null);
    try {
      if (movesPeople && impact === null) {
        setImpact(await fetchConnectorAppImpact(scope, app.slug, clientId.trim()));
        setBusy(false);
        return;
      }
      const saved = await saveConnectorApp(scope, app.slug, {
        client_id: clientId.trim(),
        ...secrets,
        replace: mode === "switch",
      });
      onSaved(saved);
    } catch (err) {
      setError(errorText(err));
      setField(err instanceof ConnectorAppRefusal ? err.field : null);
      setStep(2);
    } finally {
      setBusy(false);
    }
  };

  const title =
    mode === "switch"
      ? "Use a different app"
      : mode === "enter_again"
        ? `Enter ${app.name}'s app again`
        : `Set up ${app.kind === "github_app" ? "GitHub" : app.name}`;

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {step === 0 && (
            <Alert severity="warning">
              {switchWarning(app, app).map((line) => (
                <Typography key={line} variant="body2" sx={{ mb: 0.5 }}>
                  {line}
                </Typography>
              ))}
            </Alert>
          )}

          {step === 1 && (
            <>
              <Typography variant="subtitle1">
                Step 1 of 3 · Create the app at {vendorName(app)}
              </Typography>
              {asksWhoConnects(app) && (
                <Box>
                  <Typography variant="body1" fontWeight={600}>
                    Who will connect?
                  </Typography>
                  <RadioGroup
                    value={audience}
                    onChange={(_, value) => setAudience(value as Audience)}
                  >
                    <FormControlLabel
                      value="internal"
                      control={<Radio size="small" />}
                      label="Only people in your Google organization (recommended)"
                    />
                    <FormControlLabel
                      value="external"
                      control={<Radio size="small" />}
                      label="Anyone with a Google account"
                    />
                  </RadioGroup>
                </Box>
              )}
              <Box component="ol" sx={{ pl: 2.5, m: 0 }}>
                {setupInstructions(app, audience, publicUrl).map((instruction) => (
                  <Box component="li" key={instruction.text} sx={{ mb: 1.5 }}>
                    <Typography variant="body1">
                      {instruction.text}
                      {instruction.link && (
                        <>
                          {" "}
                          <Link href={instruction.link.href} target="_blank" rel="noreferrer">
                            {instruction.link.label}
                          </Link>
                        </>
                      )}
                    </Typography>
                    {instruction.items.length > 0 && (
                      <Box component="ul" sx={{ pl: 2.5, my: 0.5 }}>
                        {instruction.items.map((item) => (
                          <Typography
                            component="li"
                            key={item}
                            variant="body2"
                            sx={{ fontFamily: "monospace" }}
                          >
                            {item}
                          </Typography>
                        ))}
                      </Box>
                    )}
                    {instruction.copy.map((value) => (
                      <Copyable key={value} value={value} />
                    ))}
                  </Box>
                ))}
              </Box>
            </>
          )}

          {step === 2 && (
            <>
              <Typography variant="subtitle1">Step 2 of 3 · Paste its values</Typography>
              <TextField
                label="Client ID"
                value={clientId}
                autoComplete="off"
                error={field === "client_id"}
                onChange={(event) => {
                  setClientId(event.target.value);
                  setImpact(null);
                }}
              />
              <SecretInputs
                fields={fields}
                values={secrets}
                highlighted={field}
                onChange={(name, value) => setSecrets((current) => ({ ...current, [name]: value }))}
              />
              {app.kind === "github_app" && (
                <Typography variant="caption" color="text.secondary">
                  The App&apos;s name is read from GitHub when Switch checks it.
                </Typography>
              )}
              {confirmation && (
                <FormControlLabel
                  sx={{ alignItems: "flex-start" }}
                  control={
                    <Checkbox
                      size="small"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                  }
                  label={
                    <Box sx={{ pt: 0.75 }}>
                      <Typography variant="body2" fontWeight={500}>
                        {confirmation.label}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {confirmation.why}
                      </Typography>
                    </Box>
                  }
                />
              )}
              {error && <Alert severity="error">{error}</Alert>}
              {mode === "enter_again" && replacing && (
                <Alert severity="warning">
                  This is a different client ID from the one saved. Use a different app to
                  switch on purpose.
                </Alert>
              )}
              {impact && (
                <Alert severity="warning">
                  {impact.connected_members === 0
                    ? "Nobody is connected through the current app."
                    : `${peopleIn(impact)} will need to reconnect.`}
                </Alert>
              )}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {step > first && (
          <Button onClick={() => setStep(step - 1)} disabled={busy}>
            Back
          </Button>
        )}
        {step < 2 ? (
          <Button variant="contained" onClick={() => setStep(step + 1)}>
            {step === 0 ? "Continue" : "Next"}
          </Button>
        ) : (
          <Button
            variant="contained"
            color={mode === "switch" ? "warning" : "primary"}
            disabled={!complete || busy || (mode === "enter_again" && replacing)}
            onClick={() => void save()}
            startIcon={busy ? <CircularProgress size={16} /> : undefined}
          >
            {busy
              ? "Checking…"
              : movesPeople
                ? impact
                  ? mode === "switch"
                    ? "Switch app"
                    : "Check and save"
                  : "Check who reconnects"
                : "Check and save"}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
