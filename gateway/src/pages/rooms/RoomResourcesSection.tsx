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
  attachDocumentToRoom,
  attachPackageToRoom,
  attachReferenceToRoom,
  detachDocumentFromRoom,
  detachPackageFromRoom,
  detachReferenceFromRoom,
} from "../../data/api";
import {
  useDocuments,
  usePackages,
  useReferences,
  useRoomDocuments,
  useRoomPackages,
  useRoomReferences,
} from "../../data/hooks";

interface Props {
  roomId: string;
}

export default function RoomResourcesSection({ roomId }: Props) {
  const { data: roomPackages, refetch: refetchPackages } = useRoomPackages(roomId);
  const attachedPackageIds = useMemo(
    () => new Set((roomPackages ?? []).map((p) => p.id)),
    [roomPackages],
  );
  const packageDescriptions = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of roomPackages ?? []) m[p.id] = p.name || p.description;
    return m;
  }, [roomPackages]);

  return (
    <Stack spacing={3}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Resources
      </Typography>
      <RoomReferences
        roomId={roomId}
        attachedPackageIds={attachedPackageIds}
        packageDescriptions={packageDescriptions}
      />
      <RoomDocuments
        roomId={roomId}
        attachedPackageIds={attachedPackageIds}
        packageDescriptions={packageDescriptions}
      />
      <RoomPackages
        roomId={roomId}
        packages={roomPackages ?? []}
        refetch={refetchPackages}
      />
    </Stack>
  );
}

function PackageChips({
  packageIds,
  attachedPackageIds,
  packageDescriptions,
}: {
  packageIds: string[];
  attachedPackageIds: Set<string>;
  packageDescriptions: Record<string, string>;
}) {
  const navigate = useNavigate();
  const matches = packageIds.filter((id) => attachedPackageIds.has(id));
  if (matches.length === 0) return null;
  return (
    <Stack direction="row" spacing={0.5}>
      {matches.map((pid) => (
        <Chip
          key={pid}
          label={`via ${packageDescriptions[pid] ?? "package"}`}
          size="small"
          variant="outlined"
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/resources/packages/${pid}`);
          }}
        />
      ))}
    </Stack>
  );
}

function RoomReferences({
  roomId,
  attachedPackageIds,
  packageDescriptions,
}: {
  roomId: string;
  attachedPackageIds: Set<string>;
  packageDescriptions: Record<string, string>;
}) {
  const {
    data: attached,
    loading,
    error,
    refetch,
  } = useRoomReferences(roomId);
  const { data: allRefs, loading: allLoading } = useReferences();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error_, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const attachedIds = useMemo(
    () => new Set((attached ?? []).map((r) => r.id)),
    [attached],
  );

  const options = useMemo<PickerOption[]>(
    () =>
      (allRefs ?? [])
        .filter((r) => !attachedIds.has(r.id))
        .map((r) => ({
          id: r.id,
          primary: (
            <Stack direction="row" alignItems="center" spacing={1}>
              <Chip
                label={r.type_display_name ?? `${r.type} (unknown type)`}
                size="small"
              />
              <span>{r.name || r.description}</span>
            </Stack>
          ),
          search: `${r.name} ${r.description} ${r.type} ${r.type_display_name ?? ""}`.toLowerCase(),
        })),
    [allRefs, attachedIds],
  );

  const handleAttach = async (ids: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await Promise.all(ids.map((id) => attachReferenceToRoom(roomId, id)));
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to attach");
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const handleDetach = async (refId: string) => {
    setBusy(true);
    setError(null);
    try {
      await detachReferenceFromRoom(roomId, refId);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to detach");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack spacing={1}>
      <Typography variant="body2" sx={{ fontWeight: 500 }}>
        References
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {error_ && <Alert severity="error">{error_}</Alert>}
      {loading ? (
        <CircularProgress size={20} />
      ) : (attached ?? []).length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No references attached.
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {(attached ?? []).map((ref) => (
            <Stack
              key={ref.id}
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{
                px: 1,
                py: 0.5,
                borderRadius: 1,
                "&:hover": { backgroundColor: "action.hover" },
              }}
            >
              <Chip
                label={ref.type_display_name ?? `${ref.type} (unknown type)`}
                size="small"
              />
              <Typography variant="body2" sx={{ flexGrow: 1 }}>
                {ref.name || ref.description}
              </Typography>
              <PackageChips
                packageIds={ref.packages ?? []}
                attachedPackageIds={attachedPackageIds}
                packageDescriptions={packageDescriptions}
              />
              <IconButton
                size="small"
                onClick={() => handleDetach(ref.id)}
                disabled={busy}
              >
                <DeleteOutline fontSize="small" />
              </IconButton>
            </Stack>
          ))}
        </Stack>
      )}
      <Button
        size="small"
        variant="outlined"
        startIcon={<AddIcon />}
        onClick={() => setPickerOpen(true)}
        sx={{ alignSelf: "flex-start" }}
      >
        Attach reference
      </Button>
      <SearchablePickerDialog
        open={pickerOpen}
        title="Attach references"
        searchPlaceholder="Search references…"
        submitLabel="Attach"
        options={options}
        loading={allLoading}
        onClose={() => setPickerOpen(false)}
        onSubmit={handleAttach}
      />
    </Stack>
  );
}

function RoomDocuments({
  roomId,
  attachedPackageIds,
  packageDescriptions,
}: {
  roomId: string;
  attachedPackageIds: Set<string>;
  packageDescriptions: Record<string, string>;
}) {
  const {
    data: attached,
    loading,
    error,
    refetch,
  } = useRoomDocuments(roomId);
  const { data: allDocs, loading: allLoading } = useDocuments();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error_, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const attachedIds = useMemo(
    () => new Set((attached ?? []).map((d) => d.id)),
    [attached],
  );

  const options = useMemo<PickerOption[]>(
    () =>
      (allDocs ?? [])
        .filter((d) => !attachedIds.has(d.id))
        .map((d) => ({
          id: d.id,
          primary: d.name || d.description,
          search: `${d.name} ${d.description}`.toLowerCase(),
        })),
    [allDocs, attachedIds],
  );

  const handleAttach = async (ids: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await Promise.all(ids.map((id) => attachDocumentToRoom(roomId, id)));
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to attach");
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const handleDetach = async (docId: string) => {
    setBusy(true);
    setError(null);
    try {
      await detachDocumentFromRoom(roomId, docId);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to detach");
    } finally {
      setBusy(false);
    }
  };

  const navigate = useNavigate();
  const globalDocs = (attached ?? []).filter((d) => d.scope !== "room");
  const roomScopedDocs = (attached ?? []).filter((d) => d.scope === "room");

  return (
    <Stack spacing={1}>
      <Typography variant="body2" sx={{ fontWeight: 500 }}>
        Documents
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {error_ && <Alert severity="error">{error_}</Alert>}
      {loading ? (
        <CircularProgress size={20} />
      ) : (attached ?? []).length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No documents attached.
        </Typography>
      ) : (
        <Stack spacing={1.5}>
          {globalDocs.length > 0 && (
            <Stack spacing={0.5}>
              {globalDocs.map((doc) => (
                <Stack
                  key={doc.id}
                  direction="row"
                  alignItems="center"
                  spacing={1}
                  sx={{
                    px: 1,
                    py: 0.5,
                    borderRadius: 1,
                    "&:hover": { backgroundColor: "action.hover" },
                  }}
                >
                  <Typography variant="body2" sx={{ flexGrow: 1 }}>
                    {doc.name || doc.description}
                  </Typography>
                  <PackageChips
                    packageIds={doc.packages ?? []}
                    attachedPackageIds={attachedPackageIds}
                    packageDescriptions={packageDescriptions}
                  />
                  <IconButton
                    size="small"
                    onClick={() => handleDetach(doc.id)}
                    disabled={busy}
                  >
                    <DeleteOutline fontSize="small" />
                  </IconButton>
                </Stack>
              ))}
            </Stack>
          )}
          {roomScopedDocs.length > 0 && (
            <Stack spacing={0.5}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ pl: 1 }}
              >
                Room-scoped (created by agents in this room)
              </Typography>
              {roomScopedDocs.map((doc) => (
                <Stack
                  key={doc.id}
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
                  onClick={() =>
                    navigate(`/rooms/${roomId}/documents/${doc.id}`)
                  }
                >
                  <Typography variant="body2" sx={{ flexGrow: 1 }}>
                    {doc.name || doc.description}
                  </Typography>
                  {doc.created_by_agent_name && (
                    <Chip
                      label={`by ${doc.created_by_agent_name}`}
                      size="small"
                      variant="outlined"
                    />
                  )}
                  <IconButton
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDetach(doc.id);
                    }}
                    disabled={busy}
                  >
                    <DeleteOutline fontSize="small" />
                  </IconButton>
                </Stack>
              ))}
            </Stack>
          )}
        </Stack>
      )}
      <Button
        size="small"
        variant="outlined"
        startIcon={<AddIcon />}
        onClick={() => setPickerOpen(true)}
        sx={{ alignSelf: "flex-start" }}
      >
        Attach document
      </Button>
      <SearchablePickerDialog
        open={pickerOpen}
        title="Attach documents"
        searchPlaceholder="Search documents…"
        submitLabel="Attach"
        options={options}
        loading={allLoading}
        onClose={() => setPickerOpen(false)}
        onSubmit={handleAttach}
      />
    </Stack>
  );
}

function RoomPackages({
  roomId,
  packages,
  refetch,
}: {
  roomId: string;
  packages: Array<{ id: string; name: string; description: string }>;
  refetch: () => void;
}) {
  const navigate = useNavigate();
  const { data: allPackages, loading: allLoading } = usePackages();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const attachedIds = useMemo(() => new Set(packages.map((p) => p.id)), [packages]);

  const options = useMemo<PickerOption[]>(
    () =>
      (allPackages ?? [])
        .filter((p) => !attachedIds.has(p.id))
        .map((p) => ({
          id: p.id,
          primary: p.name || p.description,
          secondary: p.description || undefined,
          search: `${p.name} ${p.description}`.toLowerCase(),
        })),
    [allPackages, attachedIds],
  );

  const handleAttach = async (ids: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await Promise.all(ids.map((id) => attachPackageToRoom(roomId, id)));
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to attach");
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const handleDetach = async (pid: string) => {
    setBusy(true);
    setError(null);
    try {
      await detachPackageFromRoom(roomId, pid);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to detach");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack spacing={1}>
      <Typography variant="body2" sx={{ fontWeight: 500 }}>
        Packages
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {packages.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No packages attached.
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {packages.map((p) => (
            <Stack
              key={p.id}
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
              onClick={() => navigate(`/resources/packages/${p.id}`)}
            >
              <Typography variant="body2" sx={{ flexGrow: 1 }}>
                {p.name || p.description}
              </Typography>
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDetach(p.id);
                }}
                disabled={busy}
              >
                <DeleteOutline fontSize="small" />
              </IconButton>
            </Stack>
          ))}
        </Stack>
      )}
      <Button
        size="small"
        variant="outlined"
        startIcon={<AddIcon />}
        onClick={() => setPickerOpen(true)}
        sx={{ alignSelf: "flex-start" }}
      >
        Attach package
      </Button>
      <SearchablePickerDialog
        open={pickerOpen}
        title="Attach packages"
        searchPlaceholder="Search packages…"
        submitLabel="Attach"
        options={options}
        loading={allLoading}
        onClose={() => setPickerOpen(false)}
        onSubmit={handleAttach}
      />
    </Stack>
  );
}
