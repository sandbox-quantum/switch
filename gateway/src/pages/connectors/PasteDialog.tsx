import OpenInNewOutlined from "@mui/icons-material/OpenInNewOutlined";
import {
  Alert,
  Chip,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Link,
  MenuItem,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { type ServiceConnection, type ServicePasteMethod, connectServiceWithPaste } from "../../data/api";
import { CONSOLE_SIGN_IN_NOTE, pastedLasts, prefilledAccess } from "./connectorProfile";

/** What the person picked for the service's choices: what they connected
 * with before, else each list's first. */
function initialChoices(connection: ServiceConnection): Record<string, string> {
  return Object.fromEntries(
    (connection.sign_in_choices ?? []).map((field) => [
      field.name,
      connection.choices?.[field.name] ?? field.choices?.[0] ?? "",
    ]),
  );
}

function blank(method: ServicePasteMethod): Record<string, string> {
  return Object.fromEntries(method.fields.map((field) => [field.name, ""]));
}

/**
 * Connecting a service that signs in only through Switch Console by pasting
 * a credential in its place: the site it is for, where the service asks,
 * then a token, or keys where this server allows ones that never expire.
 * The vendor checks it before Switch stores anything, a refusal shows here,
 * and it is never shown back. Pasting again replaces what was pasted.
 */
export default function PasteDialog({
  connection,
  replacing,
  onClose,
  onSaved,
}: {
  connection: ServiceConnection;
  replacing: boolean;
  onClose: () => void;
  onSaved: (warning: string | null) => void;
}) {
  const methods = connection.paste;
  const [method, setMethod] = useState<ServicePasteMethod>(
    () => methods.find((offered) => offered.method === connection.method) ?? methods[0]!,
  );
  const [choices, setChoices] = useState<Record<string, string>>(() => initialChoices(connection));
  const [values, setValues] = useState<Record<string, string>>(() => blank(method));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const complete =
    method.fields.every((field) => values[field.name]?.trim()) &&
    (connection.sign_in_choices ?? []).every((field) => choices[field.name]);
  const vendor = connection.publisher ?? connection.name;
  const what = method.method === "token" ? "token" : "keys";

  const pick = (next: ServicePasteMethod) => {
    setMethod(next);
    setValues(blank(next));
    setError(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const fields = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value.trim()]));
      const { warning } = await connectServiceWithPaste(connection.slug, { method: method.method, fields, choices });
      onSaved(warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth={method.create_url ? "sm" : "xs"} fullWidth>
      <DialogTitle>
        {replacing
          ? `Replace your ${connection.name} ${what}`
          : method.method === "token"
            ? `Connect ${connection.name} with a ${method.label.toLowerCase()}`
            : `Connect ${connection.name}`}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {method.create_url ? (
            <Stack spacing={1.25} component="section" aria-label={`Create a ${what} in ${vendor}`}>
              <Typography variant="subtitle2" component="h3">
                1. Create a {what} in {vendor}
              </Typography>
              <DialogContentText>
                {vendor}&apos;s form opens filled in with what agents need. Choose what it can reach, then generate
                it and copy it.
              </DialogContentText>
              <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap" }} aria-label="Filled in for you">
                {prefilledAccess(method.create_url).map((said) => (
                  <Chip key={said} size="small" variant="outlined" label={said} />
                ))}
              </Stack>
              <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
                <Button
                  variant="outlined"
                  href={method.create_url}
                  target="_blank"
                  rel="noreferrer"
                  endIcon={<OpenInNewOutlined />}
                >
                  Create a {what} in {vendor}
                </Button>
                {method.help_url && (
                  <Link href={method.help_url} target="_blank" rel="noreferrer" variant="body2">
                    How {what}s work
                  </Link>
                )}
              </Stack>
              <Typography variant="subtitle2" component="h3" sx={{ pt: 1 }}>
                2. Paste it here
              </Typography>
            </Stack>
          ) : (
            <DialogContentText>
              Switch checks it with {vendor} before saving, and never shows it back.
              {method.help_url && (
                <>
                  {" "}
                  <Link href={method.help_url} target="_blank" rel="noreferrer">
                    Where to make {method.method === "token" ? "one" : "them"}
                  </Link>
                </>
              )}
            </DialogContentText>
          )}
          {(connection.sign_in_choices ?? []).map((field) => (
            <TextField
              key={field.name}
              select
              label={field.label}
              helperText={field.help ?? undefined}
              value={choices[field.name] ?? ""}
              onChange={(event) => setChoices({ ...choices, [field.name]: event.target.value })}
            >
              {(field.choices ?? []).map((choice) => (
                <MenuItem key={choice} value={choice}>
                  {choice}
                </MenuItem>
              ))}
            </TextField>
          ))}
          {methods.length > 1 && (
            <ToggleButtonGroup
              size="small"
              exclusive
              value={method.method}
              onChange={(_event, next: ServicePasteMethod["method"] | null) => {
                const chosen = methods.find((offered) => offered.method === next);
                if (chosen) pick(chosen);
              }}
              aria-label="What to paste"
            >
              {methods.map((offered) => (
                <ToggleButton key={offered.method} value={offered.method}>
                  {offered.label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          )}
          {method.fields.map((field) => (
            <TextField
              key={field.name}
              label={field.label}
              type={field.secret ? "password" : "text"}
              autoComplete="off"
              helperText={
                field.help ??
                (method.create_url
                  ? `Switch checks it with ${vendor}, keeps it encrypted, and never shows it again.`
                  : undefined)
              }
              value={values[field.name] ?? ""}
              onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
            />
          ))}
          <Typography variant="caption" color="text.secondary">
            {method.create_url
              ? method.access_note
              : `${pastedLasts(connection.name, method.expires)} ${method.access_note}`}
          </Typography>
          {!replacing && !connection.web_sign_in && connection.sign_in_unavailable_reason === null && (
            <Typography variant="caption" color="text.secondary">
              {CONSOLE_SIGN_IN_NOTE}
            </Typography>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={busy || !complete}
          onClick={() => void save()}
          startIcon={busy ? <CircularProgress size={16} /> : undefined}
        >
          {replacing ? `Replace ${what}` : "Connect"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
