import DeleteOutline from "@mui/icons-material/DeleteOutline";
import EditOutlined from "@mui/icons-material/EditOutlined";
import SwapHoriz from "@mui/icons-material/SwapHoriz";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
} from "@mui/material";
import { useCallback, useMemo, useState } from "react";
import { AccessChip, AccessSelect } from "../../components/AccessControls";
import ConfirmDialog from "../../components/ConfirmDialog";
import DataTable, {
  type FilterOption,
  type SelectFilter,
  type TableColumn,
  TableEmptyState,
} from "../../components/DataTable";
import RowActionsMenu, { type RowAction } from "../../components/RowActionsMenu";
import { TransferOwnershipDialog } from "../../components/TransferOwnershipSection";
import {
  deleteReferenceType,
  loadOwnedReferenceTypes,
  loadReferenceTypes,
  type ReferenceTypeDetail,
  updateReferenceType,
} from "../../data/api";
import {
  ACCESS_HELPERS_FOR_OTHERS,
  ACCESS_LEVELS,
  ACCESS_META,
  type AccessLevel,
  fromAccessLevel,
  toAccessLevel,
} from "../../data/visibility";
import { MONO_SX } from "../../theme/format";
import { useLoad } from "../workspace/useLoad";
import { INSTRUCTIONS_DISCLOSURE } from "./CreateReferenceTypeDialog";
import { ListBody, TruncatedText, createdColumn, useRefetchOnRefresh } from "./resourceList";

interface Props {
  refreshKey: number;
}

/** Filter values for a built-in, which has no owner and no access level of
 * its own. Neither can be a user id or an access level. */
const BUILT_IN = "built-in";

interface TypeRow {
  /** A row shadowed by a built-in shares its slug with the built-in entry, so
   *  the grid key is namespaced rather than being the slug itself. */
  id: string;
  type: string;
  display_name: string;
  value_hint: string;
  owner: string;
  created_at: string | null;
  shadowed_by_builtin: boolean;
  /** Null for a built-in: it lives in Python, not in a row, so there is
   *  nothing to edit or delete and no visibility pair to show. */
  detail: ReferenceTypeDetail | null;
}

const NOUN = { one: "reference type", other: "reference types" };

const SELECT_FILTERS: SelectFilter[] = [{ field: "owner", label: "Owner", allLabel: "All owners" }];

const SEARCH = {
  label: "Search reference types",
  text: (row: TypeRow) => [row.type, row.display_name, row.value_hint, row.owner].join(" "),
};

/** Kept stable: a fresh array each render would rebuild the grid's columns. */
const PINNED = ["actions"];

const accessValue = (row: TypeRow) => (row.detail ? toAccessLevel(row.detail) : BUILT_IN);

export default function ReferenceTypesTab({ refreshKey }: Props) {
  const visible = useLoad(loadReferenceTypes);
  const stored = useLoad(loadOwnedReferenceTypes);
  const refetchVisible = visible.refetch;
  const refetchStored = stored.refetch;
  const refreshBoth = useCallback(() => {
    void refetchVisible();
    void refetchStored();
  }, [refetchVisible, refetchStored]);
  useRefetchOnRefresh(refreshKey, refreshBoth);
  const [editing, setEditing] = useState<ReferenceTypeDetail | null>(null);
  const [deleting, setDeleting] = useState<ReferenceTypeDetail | null>(null);
  const [transferring, setTransferring] = useState<ReferenceTypeDetail | null>(null);

  const rows = useMemo<TypeRow[]>(() => {
    const builtins: TypeRow[] = (visible.data ?? [])
      .filter((t) => t.is_builtin)
      .map((t) => ({
        id: `builtin:${t.type}`,
        type: t.type,
        display_name: t.display_name,
        value_hint: t.value_hint,
        owner: "Built-in",
        created_at: null,
        shadowed_by_builtin: false,
        detail: null,
      }));
    const rest: TypeRow[] = (stored.data ?? []).map((t) => ({
      id: `row:${t.type}`,
      type: t.type,
      display_name: t.display_name,
      value_hint: t.value_hint,
      owner: t.owner_name ?? t.owner_id,
      created_at: t.created_at,
      shadowed_by_builtin: t.shadowed_by_builtin,
      detail: t,
    }));
    return [...builtins, ...rest];
  }, [visible.data, stored.data]);

  const actionsFor = useCallback((row: TypeRow): RowAction[] => {
    const detail = row.detail;
    if (!detail) return [];
    return [
      ...(detail.can_edit
        ? [{ label: "Edit", icon: <EditOutlined fontSize="small" />, onClick: () => setEditing(detail) }]
        : []),
      ...(detail.can_manage
        ? [
            { label: "Transfer ownership", icon: <SwapHoriz fontSize="small" />, onClick: () => setTransferring(detail) },
            {
              label: "Delete",
              icon: <DeleteOutline fontSize="small" />,
              destructive: true,
              onClick: () => setDeleting(detail),
            },
          ]
        : []),
    ];
  }, []);

  const columns = useMemo<TableColumn<TypeRow>[]>(() => {
    const owners = new Map<string, string>();
    for (const row of rows) {
      if (row.detail) owners.set(row.detail.owner_id, row.owner);
    }
    const ownerOptions: FilterOption[] = [
      ...(rows.some((row) => !row.detail) ? [{ value: BUILT_IN, label: "Built-in" }] : []),
      ...[...owners.entries()]
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ];
    const held = new Set(rows.map(accessValue));
    const accessOptions: FilterOption[] = [
      ...(held.has(BUILT_IN) ? [{ value: BUILT_IN, label: "Built-in" }] : []),
      ...ACCESS_LEVELS.filter((level) => held.has(level)).map((level) => ({
        value: level,
        label: ACCESS_META[level].label,
      })),
    ];
    return [
      {
        field: "type",
        headerName: "Slug",
        width: 220,
        renderCell: ({ row }) => (
          <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0, height: "100%" }}>
            <Box component="span" title={row.type} sx={{ ...MONO_SX, overflow: "hidden", textOverflow: "ellipsis" }}>
              {row.type}
            </Box>
            {row.shadowed_by_builtin && <Chip label="shadowed by built-in" size="small" color="warning" />}
          </Stack>
        ),
      },
      { field: "display_name", headerName: "Name", width: 180 },
      {
        field: "value_hint",
        headerName: "Value hint",
        flex: 1,
        minWidth: 220,
        sortable: false,
        renderCell: ({ row }) => <TruncatedText text={row.value_hint} />,
      },
      {
        field: "access",
        headerName: "Access",
        width: 120,
        valueGetter: (_value, row) => (row.detail ? ACCESS_META[toAccessLevel(row.detail)].label : "Built-in"),
        filter: { value: accessValue, options: accessOptions },
        renderCell: ({ row }) => (row.detail ? <AccessChip pair={row.detail} /> : <Chip label="Built-in" size="small" />),
      },
      {
        field: "owner",
        headerName: "Owner",
        width: 160,
        filter: { value: (row) => row.detail?.owner_id ?? BUILT_IN, options: ownerOptions },
      },
      createdColumn(),
      {
        field: "actions",
        headerName: "",
        width: 56,
        sortable: false,
        disableColumnMenu: true,
        renderCell: ({ row, tabIndex }) => (
          <RowActionsMenu label={`Actions for ${row.display_name}`} actions={actionsFor(row)} tabIndex={tabIndex} />
        ),
      },
    ];
  }, [rows, actionsFor]);

  // The two lists are one table: it waits for both, and says which failed.
  const loaded = visible.data !== null && stored.data !== null;
  const error = visible.error ?? stored.error;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <ListBody
        what="reference types"
        loaded={loaded}
        error={error}
        loading={visible.loading || stored.loading}
        onRetry={refreshBoth}
      >
        <DataTable
          rows={rows}
          columns={columns}
          fillHeight
          noun={NOUN}
          search={SEARCH}
          selectFilters={SELECT_FILTERS}
          pinnedRight={PINNED}
          emptyState={
            <TableEmptyState title="No reference types yet">
              Create one to describe a new kind of reference.
            </TableEmptyState>
          }
        />
      </ListBody>

      {editing && (
        <EditReferenceTypeDialog
          referenceType={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refreshBoth();
          }}
        />
      )}
      {transferring && (
        <TransferOwnershipDialog
          kind="reference_type"
          resourceId={transferring.type}
          resourceLabel={transferring.display_name}
          ownerId={transferring.owner_id}
          onClose={() => setTransferring(null)}
          onTransferred={() => {
            setTransferring(null);
            refreshBoth();
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete reference type"
        tone="destructive"
        confirmLabel="Delete"
        description={
          deleting && (
            <>
              Delete <b>{deleting.display_name}</b> (<code>{deleting.type}</code>)? This cannot be undone. A
              type still used by references cannot be deleted.
            </>
          )
        }
        onConfirm={async () => {
          if (!deleting) return;
          await deleteReferenceType(deleting.type);
          refreshBoth();
        }}
        onClose={() => setDeleting(null)}
      />
    </Box>
  );
}

function EditReferenceTypeDialog({
  referenceType,
  onClose,
  onSaved,
}: {
  referenceType: ReferenceTypeDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(referenceType.display_name);
  const [instructions, setInstructions] = useState(referenceType.instructions);
  const [valueHint, setValueHint] = useState(referenceType.value_hint);
  const [access, setAccess] = useState<AccessLevel>(toAccessLevel(referenceType));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await updateReferenceType(referenceType.type, {
        display_name: displayName,
        instructions,
        value_hint: valueHint,
        // Changing who may see or change it is the manager's alone.
        ...(access !== toAccessLevel(referenceType) ? fromAccessLevel(access) : {}),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save reference type");
    } finally {
      setSubmitting(false);
    }
  };

  const changed =
    displayName !== referenceType.display_name ||
    instructions !== referenceType.instructions ||
    valueHint !== referenceType.value_hint ||
    access !== toAccessLevel(referenceType);
  const canSubmit =
    changed &&
    displayName.trim().length > 0 &&
    instructions.trim().length > 0 &&
    valueHint.trim().length > 0 &&
    !submitting;

  return (
    <Dialog open onClose={handleClose} fullWidth maxWidth="sm">
      <DialogTitle>Edit reference type</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Slug"
            value={referenceType.type}
            disabled
            helperText="Stored on every reference of this type and cannot be changed."
            slotProps={{ input: { sx: { fontFamily: "monospace" } } }}
          />
          <TextField
            label="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={submitting}
            helperText="Shown wherever a reference of this type appears."
          />
          <TextField
            label="Instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            disabled={submitting}
            multiline
            minRows={4}
            helperText={INSTRUCTIONS_DISCLOSURE}
          />
          <TextField
            label="Value hint"
            value={valueHint}
            onChange={(e) => setValueHint(e.target.value)}
            disabled={submitting}
            helperText="Shown under the URL box when someone creates a reference of this type — say what those URLs should point at."
          />
          <AccessSelect
            value={access}
            onChange={setAccess}
            disabled={submitting || !referenceType.can_manage}
            helpers={referenceType.can_manage ? undefined : ACCESS_HELPERS_FOR_OTHERS}
          />
          {referenceType.shadowed_by_builtin && (
            <Alert severity="warning">
              A built-in type now uses this slug, and the built-in wins: agents
              receive its display name and instructions, not the ones here.
            </Alert>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={!canSubmit}
          startIcon={submitting ? <CircularProgress size={16} /> : undefined}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
