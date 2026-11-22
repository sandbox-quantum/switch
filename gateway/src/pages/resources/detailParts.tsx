import ArrowBack from "@mui/icons-material/ArrowBack";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import { Alert, Box, Button, Chip, CircularProgress, Stack, Typography } from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import PageBanner from "../../components/PageBanner";
import { ApiError, loadPackages } from "../../data/api";
import { mayBeInAnotherWorkspace } from "../../data/workspaceLink";
import { EM_DASH, MONO_SX } from "../../theme/format";
import { useLoad } from "../workspace/useLoad";

/** One resource for its page: loaded by id, replaced after a save, and the
 * server's reason kept when it cannot be read. */
export function useResourceDetail<T>(id: string | undefined, load: (id: string) => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
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
      setErrorStatus(null);
    } catch (err) {
      if (mine !== latest.current) return;
      setData(null);
      setError(err instanceof Error ? err.message : "Failed to load");
      setErrorStatus(err instanceof ApiError ? err.status : null);
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

  return { data, setData, error, errorStatus, loading, reload };
}

/** What a page does once its resource has been handed to someone else: it
 * shows the resource as it now stands to this viewer. A private one they
 * no longer own is gone from them (the server refuses to read it), so they go
 * back to the list. Any other failure is said on the page, over what was
 * shown before. */
export function useAfterTransfer<T>(
  id: string | undefined,
  load: (id: string) => Promise<T>,
  setData: (data: T) => void,
  listPath: string,
) {
  const navigate = useNavigate();
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const afterTransfer = async () => {
    if (!id) return;
    setRefreshError(null);
    try {
      setData(await load(id));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        navigate(listPath, { replace: true });
        return;
      }
      setRefreshError(err instanceof Error ? err.message : "unknown error");
    }
  };
  const refreshNotice = refreshError && (
    <Alert severity="warning" sx={{ mb: 2 }}>
      Transferred, but this page couldn't be refreshed: {refreshError}. Reload it to see who owns it now.
    </Alert>
  );
  return { afterTransfer, refreshNotice };
}

/** Over the page of a resource the viewer may read but not change, as the
 * agent and template pages have: disabled fields alone read as a page that
 * failed to load. `whose` says who can change it. */
export function ReadOnlyBanner({ whose }: { whose: string }) {
  return (
    <Box sx={{ mb: 2 }}>
      <PageBanner tone="neutral">{whose}</PageBanner>
    </Box>
  );
}

/** Who can change a resource someone else owns, for `ReadOnlyBanner`. An
 * owner with no name has left the workspace, as on a template's page. */
export function ownerCanChange(what: string, ownerId: string | null, ownerName: string | null): string {
  if (ownerId === null) return `This ${what} has no owner. Only a workspace admin can change it.`;
  return ownerName === null
    ? `This ${what} belongs to a former member. Only a workspace admin can change it.`
    : `This ${what} belongs to ${ownerName}. Only they or a workspace admin can change it.`;
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
  errorStatus,
  onRetry,
}: {
  what: string;
  listPath: string;
  error: string | null;
  errorStatus: number | null;
  onRetry: () => void;
}) {
  const navigate = useNavigate();
  const elsewhere = mayBeInAnotherWorkspace(errorStatus);
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
        {elsewhere !== null && (
          <Box component="span" sx={{ display: "block", mt: 0.5 }}>
            {elsewhere}
          </Box>
        )}
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

/** The packages a reference or document is in. The package list holds the
 * viewer's own and public ones, and every package for an admin, so another
 * person's private package is missing from it only for a member: counted,
 * never named, as private rooms are. */
export function InPackagesSection({ packageIds }: { packageIds: string[] }) {
  const navigate = useNavigate();
  const { data: packages, error, loading } = useLoad(loadPackages);
  const nameById = useMemo(
    () => new Map((packages ?? []).map((p) => [p.id, p.name || p.description])),
    [packages],
  );
  const named = packageIds.filter((pid) => nameById.has(pid));
  const unnamed = packageIds.filter((pid) => !nameById.has(pid));
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
          {unnamed.length > 0 && (
            <Chip
              size="small"
              variant="outlined"
              label={`${unnamed.length} private package${unnamed.length === 1 ? "" : "s"} you can't open`}
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
