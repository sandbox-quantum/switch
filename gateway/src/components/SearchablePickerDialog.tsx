import SearchIcon from "@mui/icons-material/Search";
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
  InputAdornment,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { type ReactNode, useEffect, useMemo, useState } from "react";

export interface PickerOption {
  id: string;
  primary: ReactNode;
  secondary?: ReactNode;
  /** Concatenated lower-case text used by the search filter. */
  search: string;
}

interface Props {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  options: PickerOption[];
  loading?: boolean;
  /** Why the options could not be loaded, said in place of an empty list. */
  loadError?: string | null;
  searchPlaceholder?: string;
  submitLabel?: string;
  /** If true the picker is single-select; selecting an item submits immediately. */
  singleSelect?: boolean;
  /**
   * Optional per-option secondary toggle. When `subToggleCount(id)` returns
   * > 0 and that option is selected, an inline checkbox is shown; the ids it
   * is checked for are passed as the second argument to `onSubmit`. Used to
   * opt a selected agent's subagents into the action. Multi-select only.
   */
  subToggleCount?: (id: string) => number;
  subToggleLabel?: (count: number) => string;
  onClose: () => void;
  onSubmit: (
    selectedIds: string[],
    subToggledIds: string[],
  ) => Promise<void> | void;
}

export default function SearchablePickerDialog({
  open,
  title,
  subtitle,
  options,
  loading,
  loadError = null,
  searchPlaceholder = "Search…",
  submitLabel = "Add",
  singleSelect = false,
  subToggleCount,
  subToggleLabel,
  onClose,
  onSubmit,
}: Props) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [subSelected, setSubSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSearch("");
      setSelected(new Set());
      setSubSelected(new Set());
      setError(null);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.search.includes(q));
  }, [options, search]);

  // Only what is still offered: after a submit that partly failed, the
  // options that went in are gone from the list, and must not be sent again.
  const picked = useMemo(
    () => options.filter((o) => selected.has(o.id)).map((o) => o.id),
    [options, selected],
  );

  const toggle = async (id: string) => {
    if (singleSelect) {
      setSelected(new Set([id]));
      await submit([id]);
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        // Dropping a selection also drops its sub-toggle.
        setSubSelected((s) => {
          if (!s.has(id)) return s;
          const ns = new Set(s);
          ns.delete(id);
          return ns;
        });
      } else next.add(id);
      return next;
    });
  };

  const submit = async (ids: string[]) => {
    const subIds = subToggleCount
      ? ids.filter((id) => subSelected.has(id) && subToggleCount(id) > 0)
      : [];
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(ids, subIds);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
      <DialogTitle>
        {title}
        {subtitle && (
          <Typography variant="body2" color="text.secondary">
            {subtitle}
          </Typography>
        )}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={1}>
          <TextField
            size="small"
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            fullWidth
            autoFocus
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
          {loading ? (
            <Stack alignItems="center" sx={{ py: 4 }}>
              <CircularProgress />
            </Stack>
          ) : loadError ? (
            <Alert severity="error">Couldn't load what to choose from: {loadError}</Alert>
          ) : filtered.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
              {options.length === 0 ? "Nothing to choose from." : "No matches."}
            </Typography>
          ) : (
            <List dense sx={{ maxHeight: 360, overflow: "auto" }}>
              {filtered.map((opt) => {
                const subCount = subToggleCount?.(opt.id) ?? 0;
                const showSubToggle =
                  !singleSelect && subCount > 0 && selected.has(opt.id);
                return (
                  <ListItem
                    key={opt.id}
                    disablePadding
                    sx={{ flexDirection: "column", alignItems: "stretch" }}
                  >
                    <ListItemButton
                      onClick={() => toggle(opt.id)}
                      disabled={submitting}
                    >
                      {!singleSelect && (
                        <Checkbox
                          edge="start"
                          checked={selected.has(opt.id)}
                          tabIndex={-1}
                          disableRipple
                        />
                      )}
                      <ListItemText
                        primary={opt.primary}
                        secondary={opt.secondary}
                        slotProps={{
                          secondary: {
                            sx: {
                              display: "-webkit-box",
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: "vertical",
                              overflow: "hidden",
                            },
                          },
                        }}
                      />
                    </ListItemButton>
                    {showSubToggle && (
                      <FormControlLabel
                        sx={{ pl: 5.5, mb: 0.5 }}
                        control={
                          <Checkbox
                            size="small"
                            checked={subSelected.has(opt.id)}
                            disabled={submitting}
                            onChange={(e) =>
                              setSubSelected((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(opt.id);
                                else next.delete(opt.id);
                                return next;
                              })
                            }
                          />
                        }
                        label={
                          subToggleLabel?.(subCount) ??
                          `Include ${subCount} subagent(s)`
                        }
                      />
                    )}
                  </ListItem>
                );
              })}
            </List>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={submitting}>
          Cancel
        </Button>
        {!singleSelect && (
          <Button
            variant="contained"
            onClick={() => submit(picked)}
            disabled={picked.length === 0 || submitting}
            startIcon={submitting ? <CircularProgress size={16} /> : undefined}
          >
            {submitLabel}
            {picked.length > 0 ? ` (${picked.length})` : ""}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
