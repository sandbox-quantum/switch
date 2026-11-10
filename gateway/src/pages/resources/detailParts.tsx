import ArrowBack from "@mui/icons-material/ArrowBack";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import { Alert, Box, Button, Chip, CircularProgress, Stack, Typography } from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { loadPackages } from "../../data/api";
import { EM_DASH, MONO_SX } from "../../theme/format";
import { useLoad } from "../workspace/useLoad";

/** One resource for its page: loaded by id, replaced after a save, and the
 * server's reason kept when it cannot be read. */
export function useResourceDetail<T>(id: string | undefined, load: (id: string) => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Only the latest load is kept, so moving between two resources cannot
  // leave the first one's answer on the second one's page.
  const latest = useRef(0);

  const reload = useCallback(async () => {
    if (!id) return;
    const mine = ++latest.current;
    setLoading(true);
    try {
      const loaded = await load(id);
      if (mine !== latest.current) return;
      setData(loaded);
      setError(null);
    } catch (err) {
      if (mine !== latest.current) return;
      setData(null);
      setError(err instanceof Error ? err.message : "Failed to load");
    }
    setLoading(false);
  }, [id, load]);

  // A new id is a different resource: the last one's page goes, rather than
  // stay up, editable, while the next one loads.
  useEffect(() => {
    setData(null);
    setError(null);
    void reload();
  }, [reload]);

  return { data, setData, error, loading, reload };
}

export function DetailLoading() {
  return (
    <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
      <CircularProgress />
    </Box>
  );
}

/** A resource page that could not be loaded: back to its own list, and why. */
export function DetailLoadFailed({
  what,
  listPath,
  error,
  onRetry,
}: {
  what: string;
  listPath: string;
  error: string | null;
  onRetry: () => void;
}) {
  const navigate = useNavigate();
  return (
    <Box>
      <Button startIcon={<ArrowBack />} onClick={() => navigate(listPath)}>
        Back to {what}s
      </Button>
      <Alert
        severity="error"
        sx={{ mt: 2 }}
        action={
          <Button color="inherit" size="small" onClick={onRetry}>
            Retry
          </Button>
        }
      >
        Couldn't open this {what}: {error ?? "unknown error"}
      </Alert>
    </Box>
  );
}

export function InfoLine({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <Typography variant="body2" color="text.secondary">
      <strong>{label}:</strong>{" "}
      {value ? (
        <Box component="span" sx={mono ? MONO_SX : undefined}>
          {value}
        </Box>
      ) : (
        <Box component="span" sx={{ color: "text.secondary" }}>
          {EM_DASH}
        </Box>
      )}
    </Typography>
  );
}

/** The packages a reference or document is in. A package the viewer cannot
 * list (someone's private one) is counted, never named, as private rooms
 * are. */
export function InPackagesSection({ packageIds }: { packageIds: string[] }) {
  const navigate = useNavigate();
  const { data: packages, error, loading } = useLoad(loadPackages);
  const nameById = useMemo(
    () => new Map((packages ?? []).map((p) => [p.id, p.name || p.description])),
    [packages],
  );
  const named = packageIds.filter((pid) => nameById.has(pid));
  const unnamed = packageIds.length - named.length;
  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        In packages
      </Typography>
      {packageIds.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Not in any package.
        </Typography>
      ) : loading && packages === null ? (
        <CircularProgress size={20} />
      ) : packages === null ? (
        <Alert severity="error">
          It is in {packageIds.length} package{packageIds.length === 1 ? "" : "s"}, but their names
          couldn't be loaded: {error}
        </Alert>
      ) : (
        <Stack direction="row" flexWrap="wrap" gap={0.5}>
          {named.map((pid) => (
            <Chip
              key={pid}
              label={nameById.get(pid)}
              size="small"
              variant="outlined"
              onClick={() => navigate(`/resources/packages/${pid}`)}
              sx={{ cursor: "pointer" }}
            />
          ))}
          {unnamed > 0 && (
            <Chip
              size="small"
              variant="outlined"
              label={`${unnamed} private package${unnamed === 1 ? "" : "s"} you can't open`}
            />
          )}
        </Stack>
      )}
    </Stack>
  );
}

export function DangerSection({ what, onDelete }: { what: string; onDelete: () => void }) {
  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "error.main", display: "block" }}>
        Danger zone
      </Typography>
      <Button
        variant="outlined"
        color="error"
        startIcon={<DeleteOutline />}
        onClick={onDelete}
        sx={{ alignSelf: "flex-start" }}
      >
        Delete {what}
      </Button>
    </Stack>
  );
}

/** "Required" under a field a person has emptied that may not be empty. */
export function requiredHelper(value: string, otherwise?: string): { error: boolean; helperText?: string } {
  return value.trim() === "" ? { error: true, helperText: "Required." } : { error: false, helperText: otherwise };
}
