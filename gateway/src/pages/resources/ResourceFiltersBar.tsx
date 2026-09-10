import SearchIcon from "@mui/icons-material/Search";
import {
  InputAdornment,
  MenuItem,
  Stack,
  TextField,
} from "@mui/material";

interface Owner {
  id: string;
  name: string;
}

interface TypeOption {
  value: string;
  label: string;
}

interface Props {
  search: string;
  onSearchChange: (v: string) => void;
  ownerId: string;
  onOwnerChange: (id: string) => void;
  owners: Owner[];
  typeFilter?: string;
  onTypeChange?: (t: string) => void;
  types?: TypeOption[];
  /** What this axis is called on the resource being listed. */
  typeLabel?: string;
}

export default function ResourceFiltersBar({
  search,
  onSearchChange,
  ownerId,
  onOwnerChange,
  owners,
  typeFilter,
  onTypeChange,
  types,
  typeLabel = "Type",
}: Props) {
  const hasType = types !== undefined && onTypeChange !== undefined;

  return (
    <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
      <TextField
        size="small"
        placeholder="Search by name…"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        sx={{ minWidth: 240 }}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          },
        }}
      />
      <TextField
        size="small"
        select
        label="Owner"
        value={ownerId}
        onChange={(e) => onOwnerChange(e.target.value)}
        sx={{ minWidth: 180 }}
      >
        <MenuItem value="">All owners</MenuItem>
        {owners.map((o) => (
          <MenuItem key={o.id} value={o.id}>
            {o.name}
          </MenuItem>
        ))}
      </TextField>
      {hasType && (
        <TextField
          size="small"
          select
          label={typeLabel}
          value={typeFilter ?? ""}
          onChange={(e) => onTypeChange(e.target.value)}
          sx={{ minWidth: 180 }}
        >
          <MenuItem value="">{`All ${typeLabel.toLowerCase()}s`}</MenuItem>
          {(types ?? []).map((t) => (
            <MenuItem key={t.value} value={t.value}>
              {t.label}
            </MenuItem>
          ))}
        </TextField>
      )}
    </Stack>
  );
}
