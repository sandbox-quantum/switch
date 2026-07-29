import AddIcon from "@mui/icons-material/Add";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import {
  Alert,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  Typography,
} from "@mui/material";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import SearchablePickerDialog, {
  type PickerOption,
} from "../../components/SearchablePickerDialog";
import {
  addDocumentToPackage,
  addReferenceToPackage,
  removeDocumentFromPackage,
  removeReferenceFromPackage,
} from "../../data/api";
import {
  useDocuments,
  usePackageDocuments,
  usePackageReferences,
  useReferenceTypes,
  useReferences,
} from "../../data/hooks";

interface Props {
  packageId: string;
  canMutate: boolean;
}

export default function PackageMembersSection({ packageId, canMutate }: Props) {
  const navigate = useNavigate();
  const { data: types } = useReferenceTypes();
  const { data: pkgRefs, loading: refsLoading, refetch: refetchRefs } =
    usePackageReferences(packageId);
  const { data: pkgDocs, loading: docsLoading, refetch: refetchDocs } =
    usePackageDocuments(packageId);
  const { data: allRefs } = useReferences();
  const { data: allDocs } = useDocuments();
  const [refPickerOpen, setRefPickerOpen] = useState(false);
  const [docPickerOpen, setDocPickerOpen] = useState(false);
  const [removeWarning, setRemoveWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const typeLabel = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of types ?? []) m[t.type] = t.display_name;
    return m;
  }, [types]);

  const refIds = useMemo(
    () => new Set((pkgRefs ?? []).map((r) => r.id)),
    [pkgRefs],
  );
  const docIds = useMemo(
    () => new Set((pkgDocs ?? []).map((d) => d.id)),
    [pkgDocs],
  );

  const refOptions = useMemo<PickerOption[]>(
    () =>
      (allRefs ?? [])
        .filter((r) => !refIds.has(r.id))
        .map((r) => ({
          id: r.id,
          primary: r.name || "(unnamed)",
          secondary: typeLabel[r.type] ?? r.type,
          search: `${r.name} ${r.description} ${r.type}`.toLowerCase(),
        })),
    [allRefs, refIds, typeLabel],
  );
  const docOptions = useMemo<PickerOption[]>(
    () =>
      (allDocs ?? [])
        .filter((d) => !docIds.has(d.id))
        .map((d) => ({
          id: d.id,
          primary: d.name || "(unnamed)",
          secondary: d.description || undefined,
          search: `${d.name} ${d.description ?? ""}`.toLowerCase(),
        })),
    [allDocs, docIds],
  );

  const handleAddRefs = async (ids: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await Promise.all(ids.map((rid) => addReferenceToPackage(packageId, rid)));
      refetchRefs();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add references");
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const handleAddDocs = async (ids: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await Promise.all(ids.map((did) => addDocumentToPackage(packageId, did)));
      refetchDocs();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add documents");
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveRef = async (refId: string) => {
    setBusy(true);
    setError(null);
    setRemoveWarning(null);
    try {
      const result = await removeReferenceFromPackage(packageId, refId);
      if (result.affected_room_names.length > 0) {
        setRemoveWarning(
          `Removed. ${result.affected_room_names.length} room(s) lost visibility: ${result.affected_room_names.join(", ")}`,
        );
      }
      refetchRefs();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove reference");
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveDoc = async (docId: string) => {
    setBusy(true);
    setError(null);
    setRemoveWarning(null);
    try {
      const result = await removeDocumentFromPackage(packageId, docId);
      if (result.affected_room_names.length > 0) {
        setRemoveWarning(
          `Removed. ${result.affected_room_names.length} room(s) lost visibility: ${result.affected_room_names.join(", ")}`,
        );
      }
      refetchDocs();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove document");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack spacing={3}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Members
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {removeWarning && (
        <Alert severity="warning" onClose={() => setRemoveWarning(null)}>
          {removeWarning}
        </Alert>
      )}

      <Stack spacing={1}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          References
        </Typography>
        {refsLoading ? (
          <CircularProgress size={20} />
        ) : (pkgRefs ?? []).length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No references in this package.
          </Typography>
        ) : (
          <Stack spacing={0.5}>
            {(pkgRefs ?? []).map((r) => (
              <Stack
                key={r.id}
                direction="row"
                alignItems="center"
                spacing={1}
                sx={{
                  px: 1,
                  py: 0.5,
                  borderRadius: 1,
                  cursor: "pointer",
                  "&:hover": { backgroundColor: "action.hover" },
                }}
                onClick={() => navigate(`/resources/references/${r.id}`)}
              >
                <Chip label={typeLabel[r.type] ?? r.type} size="small" />
                <Typography variant="body2" sx={{ flexGrow: 1 }}>
                  {r.name || "(unnamed)"}
                </Typography>
                {canMutate && (
                  <IconButton
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemoveRef(r.id);
                    }}
                    disabled={busy}
                  >
                    <DeleteOutline fontSize="small" />
                  </IconButton>
                )}
              </Stack>
            ))}
          </Stack>
        )}
        {canMutate && (
          <Button
            size="small"
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={() => setRefPickerOpen(true)}
            sx={{ alignSelf: "flex-start" }}
          >
            Add references
          </Button>
        )}
      </Stack>

      <Stack spacing={1}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Documents
        </Typography>
        {docsLoading ? (
          <CircularProgress size={20} />
        ) : (pkgDocs ?? []).length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No documents in this package.
          </Typography>
        ) : (
          <Stack spacing={0.5}>
            {(pkgDocs ?? []).map((d) => (
              <Stack
                key={d.id}
                direction="row"
                alignItems="center"
                spacing={1}
                sx={{
                  px: 1,
                  py: 0.5,
                  borderRadius: 1,
                  cursor: "pointer",
                  "&:hover": { backgroundColor: "action.hover" },
                }}
                onClick={() => navigate(`/resources/documents/${d.id}`)}
              >
                <Typography variant="body2" sx={{ flexGrow: 1 }}>
                  {d.name || "(unnamed)"}
                </Typography>
                {canMutate && (
                  <IconButton
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemoveDoc(d.id);
                    }}
                    disabled={busy}
                  >
                    <DeleteOutline fontSize="small" />
                  </IconButton>
                )}
              </Stack>
            ))}
          </Stack>
        )}
        {canMutate && (
          <Button
            size="small"
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={() => setDocPickerOpen(true)}
            sx={{ alignSelf: "flex-start" }}
          >
            Add documents
          </Button>
        )}
      </Stack>

      <SearchablePickerDialog
        open={refPickerOpen}
        title="Add references"
        searchPlaceholder="Search references…"
        options={refOptions}
        onClose={() => setRefPickerOpen(false)}
        onSubmit={handleAddRefs}
      />
      <SearchablePickerDialog
        open={docPickerOpen}
        title="Add documents"
        searchPlaceholder="Search documents…"
        options={docOptions}
        onClose={() => setDocPickerOpen(false)}
        onSubmit={handleAddDocs}
      />
    </Stack>
  );
}
