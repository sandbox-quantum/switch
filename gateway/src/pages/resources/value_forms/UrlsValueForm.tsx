import { Stack, TextField, Typography } from "@mui/material";
import { useState } from "react";
import type { ValueFormProps } from "./types";

interface Props extends ValueFormProps {
  helperText: string;
}

/** The URLs in a box's text: one per line, blank lines ignored. */
export function parseUrls(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Shared form for any reference type whose value is `{urls: string[]}`.
 * URLs are entered one per line. Empty lines are ignored.
 *
 * The box keeps its own text, as typed: rebuilt from the parsed URLs, a new
 * line would vanish the moment it was typed, since an empty line parses to
 * nothing. It is reseeded only when the value changes from outside, such as
 * the type being changed.
 */
export default function UrlsValueForm({
  value,
  onChange,
  disabled,
  helperText,
}: Props) {
  const urls = Array.isArray(value.urls) ? (value.urls as string[]) : [];
  const joined = urls.join("\n");
  const [text, setText] = useState(joined);
  const [seen, setSeen] = useState(joined);
  if (joined !== seen) {
    setSeen(joined);
    if (parseUrls(text).join("\n") !== joined) setText(joined);
  }

  const handleChange = (raw: string) => {
    setText(raw);
    const next = parseUrls(raw);
    setSeen(next.join("\n"));
    onChange({ urls: next });
  };

  return (
    <Stack spacing={1}>
      <Typography variant="caption" color="text.secondary">
        {helperText}
      </Typography>
      <TextField
        label="URLs (one per line)"
        multiline
        minRows={4}
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        disabled={disabled}
        fullWidth
      />
    </Stack>
  );
}
