import AddIcon from "@mui/icons-material/Add";
import {
  Alert,
  Button,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import ConfirmDialog from "../../components/ConfirmDialog";
import SearchablePickerDialog, {
  type PickerOption,
} from "../../components/SearchablePickerDialog";
import {
  addDocumentToPackage,
  addReferenceToPackage,
  loadDocuments,
  loadPackageDocuments,
  loadPackageReferences,
  loadReferences,
  removeDocumentFromPackage,
  removeReferenceFromPackage,
  type PackageMemberRemoveResult,
} from "../../data/api";
import { LockedMark, OpensMark } from "../../components/RowAccess";
import { useLoad } from "../workspace/useLoad";
import { privateRoomsLabel } from "./privateRooms";
import { referenceTypeLabel } from "./ReferencesTab";

interface Props {
  packageId: string;
  canMutate: boolean;
}

type MemberKind = "reference" | "document";

interface Member {
  id: string;
  name: string;
  can_read: boolean;
}

/** A member about to be taken out of the package, once confirmed. */
interface Removing {
  kind: MemberKind;
  id: string;
  name: string;
}

/** Each item is added on its own, so some may go in while others are
 * refused. Throws the reasons for the refused ones, for the picker to show,
 * once `refetch` has shown the ones that went in. */
async function addEach(ids: string[], add: (id: string) => Promise<unknown>, refetch: () => Promise<void>) {
  const results = await Promise.allSettled(ids.map(add));
  // Awaited, so the picker no longer offers what went in by the time it
  // shows the reasons for the rest.
  await refetch();
  const refused = results.flatMap((result) =>
    result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
      : [],
  );
  if (refused.length === 0) return;
  const reasons = [...new Set(refused)].join(" ");
  throw new Error(
    refused.length === ids.length ? reasons : `Added ${ids.length - refused.length} of ${ids.length}. ${reasons}`,
  );
}

export default function PackageMembersSection({ packageId, canMutate }: Props) {
  const loadRefs = useCallback(() => loadPackageReferences(packageId), [packageId]);
  const loadDocs = useCallback(() => loadPackageDocuments(packageId), [packageId]);
  const refs = useLoad(loadRefs);
  const docs = useLoad(loadDocs);
  const [picker, setPicker] = useState<MemberKind | null>(null);
  const [removing, setRemoving] = useState<Removing | null>(null);
  const [removeWarning, setRemoveWarning] = useState<string | null>(null);

  const refIds = useMemo(() => new Set((refs.data ?? []).map((r) => r.id)), [refs.data]);
  const docIds = useMemo(() => new Set((docs.data ?? []).map((d) => d.id)), [docs.data]);

  const remove = async () => {
    if (!removing) return;
    setRemoveWarning(null);
    const result =
      removing.kind === "reference"
        ? await removeReferenceFromPackage(packageId, removing.id)
        : await removeDocumentFromPackage(packageId, removing.id);
    setRemoveWarning(lostVisibilityWarning(result));
    void (removing.kind === "reference" ? refs.refetch() : docs.refetch());
  };

  return (
    <Stack spacing={3}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Members
      </Typography>
      {removeWarning && (
        <Alert severity="warning" onClose={() => setRemoveWarning(null)}>
          {removeWarning}
        </Alert>
      )}

      <MemberList
        kind="reference"
        title="References"
        state={refs}
        canMutate={canMutate}
        onAdd={() => setPicker("reference")}
        onRemove={(member) => setRemoving({ kind: "reference", id: member.id, name: member.name })}
        leading={(member) => <Chip label={referenceTypeLabel(member)} size="small" />}
      />
      <MemberList
        kind="document"
        title="Documents"
        state={docs}
        canMutate={canMutate}
        onAdd={() => setPicker("document")}
        onRemove={(member) => setRemoving({ kind: "document", id: member.id, name: member.name })}
      />

      {picker === "reference" && (
        <ReferencePicker
          memberIds={refIds}
          onClose={() => setPicker(null)}
          onSubmit={(ids) => addEach(ids, (rid) => addReferenceToPackage(packageId, rid), refs.refetch)}
        />
      )}
      {picker === "document" && (
        <DocumentPicker
          memberIds={docIds}
          onClose={() => setPicker(null)}
          onSubmit={(ids) => addEach(ids, (did) => addDocumentToPackage(packageId, did), docs.refetch)}
        />
      )}

      <ConfirmDialog
        open={removing !== null}
        title="Remove from package"
        tone="destructive"
        confirmLabel="Remove"
        description={
          <>
            Take <b>{removing?.name || "(unnamed)"}</b> out of this package? Rooms that get it only through
            the package stop getting it. The {removing?.kind} itself is kept.
          </>
        }
        onConfirm={remove}
        onClose={() => setRemoving(null)}
      />
    </Stack>
  );
}

function MemberList<T extends Member>({
  kind,
  title,
  state,
  canMutate,
  onAdd,
  onRemove,
  leading,
}: {
  kind: MemberKind;
  title: string;
  state: { data: readonly T[] | null; error: string | null; loading: boolean };
  canMutate: boolean;
  onAdd: () => void;
  onRemove: (member: T) => void;
  leading?: (member: T) => ReactNode;
}) {
  const navigate = useNavigate();
  const { data, error, loading } = state;
  return (
    <Stack spacing={1}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      {loading && data === null ? (
        <CircularProgress size={20} />
      ) : data === null ? (
        <Alert severity="error">
          Couldn't load the package's {title.toLowerCase()}: {error}
        </Alert>
      ) : data.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No {title.toLowerCase()} in this package.
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {error && (
            <Alert severity="warning">
              Couldn't refresh the package's {title.toLowerCase()}: {error}
            </Alert>
          )}
          {data.map((member) => (
            <Stack
              key={member.id}
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{
                px: 1,
                py: 0.5,
                borderRadius: 1,
                ...(member.can_read && {
                  cursor: "pointer",
                  "&:hover": { backgroundColor: "action.hover" },
                }),
              }}
              // A private item is listed to whoever may read the package,
              // but its own page would refuse them: no link.
              onClick={member.can_read ? () => navigate(`/resources/${kind}s/${member.id}`) : undefined}
              data-testid={`package-${kind}-${member.id}`}
            >
              {leading?.(member)}
              <Typography variant="body2" color={member.can_read ? undefined : "text.secondary"}>
                {member.name || "(unnamed)"}
              </Typography>
              {!member.can_read && <LockedMark />}
              <span style={{ flexGrow: 1 }} />
              {member.can_read && <OpensMark />}
              {canMutate && (
                <Button
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(member);
                  }}
                  aria-label={`Remove ${member.name || "(unnamed)"} from package`}
                >
                  Remove
                </Button>
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
          onClick={onAdd}
          sx={{ alignSelf: "flex-start" }}
        >
          Add {title.toLowerCase()}
        </Button>
      )}
    </Stack>
  );
}

// The pickers are mounted only while open, so what they offer loads only
// when someone adds to the package.

function ReferencePicker({
  memberIds,
  onClose,
  onSubmit,
}: {
  memberIds: Set<string>;
  onClose: () => void;
  onSubmit: (ids: string[]) => Promise<void>;
}) {
  const { data, error, loading } = useLoad(loadReferences);
  const options = useMemo<PickerOption[]>(
    () =>
      (data ?? [])
        .filter((r) => !memberIds.has(r.id))
        .map((r) => ({
          id: r.id,
          primary: r.name || "(unnamed)",
          secondary: referenceTypeLabel(r),
          search: `${r.name} ${r.description} ${r.type}`.toLowerCase(),
        })),
    [data, memberIds],
  );
  return (
    <SearchablePickerDialog
      open
      title="Add references"
      searchPlaceholder="Search references…"
      options={options}
      loading={loading && data === null}
      loadError={data === null ? error : null}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}

function DocumentPicker({
  memberIds,
  onClose,
  onSubmit,
}: {
  memberIds: Set<string>;
  onClose: () => void;
  onSubmit: (ids: string[]) => Promise<void>;
}) {
  const { data, error, loading } = useLoad(loadDocuments);
  const options = useMemo<PickerOption[]>(
    () =>
      (data ?? [])
        .filter((d) => !memberIds.has(d.id))
        .map((d) => ({
          id: d.id,
          primary: d.name || "(unnamed)",
          secondary: d.description || undefined,
          search: `${d.name} ${d.description ?? ""}`.toLowerCase(),
        })),
    [data, memberIds],
  );
  return (
    <SearchablePickerDialog
      open
      title="Add documents"
      searchPlaceholder="Search documents…"
      options={options}
      loading={loading && data === null}
      loadError={data === null ? error : null}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}

// Rooms the viewer may not read are counted, never named.
function lostVisibilityWarning(result: PackageMemberRemoveResult): string | null {
  const named = result.affected_room_names;
  const hidden = result.hidden_affected_rooms_count;
  if (named.length + hidden === 0) return null;
  const rooms = [...named, ...(hidden > 0 ? [privateRoomsLabel(hidden)] : [])];
  return `Removed. ${named.length + hidden} room(s) lost visibility: ${rooms.join(", ")}`;
}
