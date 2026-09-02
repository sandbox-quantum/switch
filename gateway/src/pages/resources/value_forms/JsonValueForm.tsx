import { Alert, Stack, TextField, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import type { ValueFormProps } from "./types";

interface Props extends ValueFormProps {
  onValidityChange: (valid: boolean) => void;
}

/**
 * Raw editor for a value bag that is not `{urls: string[]}`. Every reference
 * type shares the URL shape, so this is reached only by a legacy row. Parses
 * on every keystroke and reports validity upward: the parent holds the last
 * successfully parsed value, so without that signal an invalid edit would
 * submit the stale one.
 */
export default function JsonValueForm({
  value,
  onChange,
  disabled,
  onValidityChange,
}: Props) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(JSON.stringify(value ?? {}, null, 2));
    // Only refresh from prop when the editor isn't actively being typed in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = (raw: string) => {
    setText(raw);
    try {
      const parsed = raw.trim() === "" ? {} : JSON.parse(raw);
      onChange(parsed as Record<string, unknown>);
      setError(null);
      onValidityChange(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid JSON");
      onValidityChange(false);
    }
  };

  return (
    <Stack spacing={1}>
      <Typography variant="caption" color="text.secondary">
        This value is not a list of URLs, so it is shown as raw JSON.
      </Typography>
      <TextField
        label="Value (JSON)"
        multiline
        minRows={6}
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        disabled={disabled}
        fullWidth
        slotProps={{ input: { sx: { fontFamily: "monospace" } } }}
      />
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  );
}
