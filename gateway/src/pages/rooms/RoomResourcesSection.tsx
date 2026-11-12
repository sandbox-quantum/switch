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
import { type ReactNode, useMemo, useState } from "react";
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
import { LockedMark, OpensMark } from "../../components/RowAccess";

interface Props {
  roomId: string;
  // Attaching takes write access to the room; detaching takes part in it.
  canWrite: boolean;
  canUnlink: boolean;
}

export default function RoomResourcesSection({ roomId, canWrite, canUnlink }: Props) {
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
  // A private package attached by its owner is listed to every reader of the
  // room, but only those the server says may read it get a link to it.
  const readablePackageIds = useMemo(
    () => new Set((roomPackages ?? []).filter((p) => p.can_read).map((p) => p.id)),
    [roomPackages],
  );

  return (
    <Stack spacing={3}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Resources
      </Typography>
      <RoomReferences
        roomId={roomId}
        canWrite={canWrite}
        canUnlink={canUnlink}
        attachedPackageIds={attachedPackageIds}
        readablePackageIds={readablePackageIds}
        packageDescriptions={packageDescriptions}
      />
      <RoomDocuments
        roomId={roomId}
        canWrite={canWrite}
        attachedPackageIds={attachedPackageIds}
        readablePackageIds={readablePackageIds}
        packageDescriptions={packageDescriptions}
      />
      <RoomPackages
        roomId={roomId}
        canWrite={canWrite}
        canUnlink={canUnlink}
        packages={roomPackages ?? []}
        refetch={refetchPackages}
      />
    </Stack>
  );
}

function PackageChips({
  packageIds,
  attachedPackageIds,
  readablePackageIds,
  packageDescriptions,
}: {
  packageIds: string[];
  attachedPackageIds: Set<string>;
  readablePackageIds: Set<string>;
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
          onClick={
            readablePackageIds.has(pid)
              ? (e) => {
                  e.stopPropagation();
                  navigate(`/resources/packages/${pid}`);
                }
              : undefined
          }
        />
      ))}
    </Stack>
  );
}

function RoomReferences({
  roomId,
  canWrite,
  canUnlink,
  attachedPackageIds,
  readablePackageIds,
  packageDescriptions,
}: {
  roomId: string;
  canWrite: boolean;
  canUnlink: boolean;
  attachedPackageIds: Set<string>;
  readablePackageIds: Set<string>;
  packageDescriptions: Record<string, string>;
}) {
  const {
    data: attached,
    loading,
    error,
    refetch,
  } = useRoomReferences(roomId);
  const [error_, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const attachedIds = useMemo(
    () => new Set((attached ?? []).map((r) => r.id)),
    [attached],
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
                readablePackageIds={readablePackageIds}
                packageDescriptions={packageDescriptions}
              />
              {canUnlink && (
                <Button
                  size="small"
                  onClick={() => handleDetach(ref.id)}
                  disabled={busy}
                  aria-label={`Detach ${ref.name || ref.description}`}
                >
                  Detach
                </Button>
              )}
            </Stack>
          ))}
        </Stack>
      )}
      <AttachControl canWrite={canWrite} label="Attach reference">
        {(close) => (
          <ReferencePicker
            attachedIds={attachedIds}
            onClose={close}
            onSubmit={handleAttach}
          />
        )}
      </AttachControl>
    </Stack>
  );
}

function RoomDocuments({
  roomId,
  canWrite,
  attachedPackageIds,
  readablePackageIds,
  packageDescriptions,
}: {
  roomId: string;
  canWrite: boolean;
  attachedPackageIds: Set<string>;
  readablePackageIds: Set<string>;
  packageDescriptions: Record<string, string>;
}) {
  const {
    data: attached,
    loading,
    error,
    refetch,
  } = useRoomDocuments(roomId);
  const [error_, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const attachedIds = useMemo(
    () => new Set((attached ?? []).map((d) => d.id)),
    [attached],
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
                    readablePackageIds={readablePackageIds}
                    packageDescriptions={packageDescriptions}
                  />
                  {doc.can_remove && (
                    <Button
                      size="small"
                      onClick={() => handleDetach(doc.id)}
                      disabled={busy}
                      aria-label={`Detach ${doc.name || doc.description}`}
                    >
                      Detach
                    </Button>
                  )}
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
                  {doc.can_remove && (
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (
                          window.confirm(
                            `Delete room document “${doc.name || doc.description}”? This cannot be undone.`,
                          )
                        )
                          handleDetach(doc.id);
                      }}
                      disabled={busy}
                      aria-label={`Delete ${doc.name || doc.description}`}
                    >
                      <DeleteOutline fontSize="small" />
                    </IconButton>
                  )}
                </Stack>
              ))}
            </Stack>
          )}
        </Stack>
      )}
      <AttachControl canWrite={canWrite} label="Attach document">
        {(close) => (
          <DocumentPicker
            attachedIds={attachedIds}
            onClose={close}
            onSubmit={handleAttach}
          />
        )}
      </AttachControl>
    </Stack>
  );
}

function RoomPackages({
  roomId,
  canWrite,
  canUnlink,
  packages,
  refetch,
}: {
  roomId: string;
  canWrite: boolean;
  canUnlink: boolean;
  packages: Array<{ id: string; name: string; description: string; can_read?: boolean }>;
  refetch: () => void;
}) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const attachedIds = useMemo(() => new Set(packages.map((p) => p.id)), [packages]);

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
                ...(p.can_read && {
                  cursor: "pointer",
                  "&:hover": { backgroundColor: "action.hover" },
                }),
              }}
              onClick={p.can_read ? () => navigate(`/resources/packages/${p.id}`) : undefined}
              data-testid={`room-package-${p.id}`}
            >
              <Typography
                variant="body2"
                color={p.can_read ? undefined : "text.secondary"}
              >
                {p.name || p.description}
              </Typography>
              {!p.can_read && <LockedMark />}
              <span style={{ flexGrow: 1 }} />
              {p.can_read && <OpensMark />}
              {canUnlink && (
                <Button
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDetach(p.id);
                  }}
                  disabled={busy}
                  aria-label={`Detach ${p.name || p.description}`}
                >
                  Detach
                </Button>
              )}
            </Stack>
          ))}
        </Stack>
      )}
      <AttachControl canWrite={canWrite} label="Attach package">
        {(close) => (
          <PackagePicker
            attachedIds={attachedIds}
            onClose={close}
            onSubmit={handleAttach}
          />
        )}
      </AttachControl>
    </Stack>
  );
}

// The Attach button and its picker, for those who may write to the room. The
// picker is mounted only while open, so the list it offers loads only when
// someone attaches.
function AttachControl({
  canWrite,
  label,
  children,
}: {
  canWrite: boolean;
  label: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!canWrite) return null;
  return (
    <>
      <Button
        size="small"
        variant="outlined"
        startIcon={<AddIcon />}
        onClick={() => setOpen(true)}
        sx={{ alignSelf: "flex-start" }}
      >
        {label}
      </Button>
      {open && children(() => setOpen(false))}
    </>
  );
}

interface PickerProps {
  attachedIds: Set<string>;
  onClose: () => void;
  onSubmit: (ids: string[]) => Promise<void>;
}

function ReferencePicker({ attachedIds, onClose, onSubmit }: PickerProps) {
  const { data, loading } = useReferences();
  const options = useMemo<PickerOption[]>(
    () =>
      (data ?? [])
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
    [data, attachedIds],
  );
  return (
    <SearchablePickerDialog
      open
      title="Attach references"
      searchPlaceholder="Search references…"
      submitLabel="Attach"
      options={options}
      loading={loading}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}

function DocumentPicker({ attachedIds, onClose, onSubmit }: PickerProps) {
  const { data, loading } = useDocuments();
  const options = useMemo<PickerOption[]>(
    () =>
      (data ?? [])
        .filter((d) => !attachedIds.has(d.id))
        .map((d) => ({
          id: d.id,
          primary: d.name || d.description,
          search: `${d.name} ${d.description}`.toLowerCase(),
        })),
    [data, attachedIds],
  );
  return (
    <SearchablePickerDialog
      open
      title="Attach documents"
      searchPlaceholder="Search documents…"
      submitLabel="Attach"
      options={options}
      loading={loading}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}

function PackagePicker({ attachedIds, onClose, onSubmit }: PickerProps) {
  const { data, loading } = usePackages();
  const options = useMemo<PickerOption[]>(
    () =>
      (data ?? [])
        .filter((p) => !attachedIds.has(p.id))
        .map((p) => ({
          id: p.id,
          primary: p.name || p.description,
          secondary: p.description || undefined,
          search: `${p.name} ${p.description}`.toLowerCase(),
        })),
    [data, attachedIds],
  );
  return (
    <SearchablePickerDialog
      open
      title="Attach packages"
      searchPlaceholder="Search packages…"
      submitLabel="Attach"
      options={options}
      loading={loading}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}
