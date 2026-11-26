import { MenuItem, type SxProps, TextField, type Theme } from "@mui/material";
import type { TemplateUseCase } from "../../data/api";
import { USE_CASES } from "./templateRows";

const NONE = "";

/** What a template is for, from the server's list, or none. */
export default function UseCaseSelect({
  value,
  onChange,
  disabled,
  sx,
}: {
  value: TemplateUseCase | null;
  onChange: (useCase: TemplateUseCase | null) => void;
  disabled: boolean;
  sx?: SxProps<Theme>;
}) {
  return (
    <TextField
      select
      label="Use case"
      value={value ?? NONE}
      onChange={(e) => onChange(e.target.value === NONE ? null : (e.target.value as TemplateUseCase))}
      disabled={disabled}
      helperText="Optional. Shown on the template's card, and searched alongside its name."
      // Said here rather than left to the theme: "None" is a choice, and
      // must show as one.
      slotProps={{ select: { displayEmpty: true } }}
      sx={sx}
    >
      <MenuItem value={NONE}>None</MenuItem>
      {USE_CASES.map((u) => (
        <MenuItem key={u.value} value={u.value}>
          {u.label}
        </MenuItem>
      ))}
    </TextField>
  );
}
