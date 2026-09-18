import { Chip, MenuItem, TextField } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";

import {
  ACCESS_LEVELS,
  ACCESS_META,
  type AccessLevel,
  toAccessLevel,
  type VisibilityPair,
} from "../data/visibility";

/** A compact chip summarising an entity's read/write visibility as one of the
 * three access levels (Private / Read-only / Public). */
export function AccessChip({
  pair,
  size = "small",
}: {
  pair: VisibilityPair;
  size?: "small" | "medium";
}) {
  const meta = ACCESS_META[toAccessLevel(pair)];
  return <Chip label={meta.label} size={size} color={meta.color} />;
}

interface AccessSelectProps {
  value: AccessLevel;
  onChange: (level: AccessLevel) => void;
  disabled?: boolean;
  label?: string;
  /** Helper text per level, where the shared wording does not fit the
   * resource (a template is used, not attached). */
  helpers?: Partial<Record<AccessLevel, string>>;
  sx?: SxProps<Theme>;
}

/** A single 3-option select for the access level, with per-level helper text.
 * Replaces the old public/private visibility dropdown. */
export function AccessSelect({
  value,
  onChange,
  disabled,
  label = "Access",
  helpers,
  sx,
}: AccessSelectProps) {
  return (
    <TextField
      select
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as AccessLevel)}
      disabled={disabled}
      helperText={helpers?.[value] ?? ACCESS_META[value].helper}
      sx={sx}
    >
      {ACCESS_LEVELS.map((lvl) => (
        <MenuItem key={lvl} value={lvl}>
          {ACCESS_META[lvl].optionLabel}
        </MenuItem>
      ))}
    </TextField>
  );
}
