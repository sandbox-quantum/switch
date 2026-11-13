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
  /** Empty when nothing is chosen yet; `emptyHelper` then says what happens. */
  value: AccessLevel | "";
  onChange: (level: AccessLevel) => void;
  /** The levels offered, where not all three apply (a room is public or
   * private). */
  levels?: AccessLevel[];
  emptyHelper?: string;
  disabled?: boolean;
  label?: string;
  /** Helper text per level, where the shared wording does not fit the
   * resource (a template is used, not attached). */
  helpers?: Partial<Record<AccessLevel, string>>;
  /** Option labels per level, where the shared ones do not fit (a private
   * room is seen by those taking part in it, not "only me"). */
  optionLabels?: Partial<Record<AccessLevel, string>>;
  sx?: SxProps<Theme>;
}

/** A single select for the access level (all three, or the `levels` given),
 * with per-level helper text. */
export function AccessSelect({
  value,
  onChange,
  disabled,
  label = "Access",
  levels = ACCESS_LEVELS,
  emptyHelper,
  helpers,
  optionLabels,
  sx,
}: AccessSelectProps) {
  return (
    <TextField
      select
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as AccessLevel)}
      disabled={disabled}
      helperText={value === "" ? emptyHelper : (helpers?.[value] ?? ACCESS_META[value].helper)}
      sx={sx}
    >
      {levels.map((lvl) => (
        <MenuItem key={lvl} value={lvl}>
          {optionLabels?.[lvl] ?? ACCESS_META[lvl].optionLabel}
        </MenuItem>
      ))}
    </TextField>
  );
}
