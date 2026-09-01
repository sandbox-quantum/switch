import DeleteOutline from "@mui/icons-material/DeleteOutline";
import EditOutlined from "@mui/icons-material/EditOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { useEffect, useMemo, useState } from "react";
import DataTable from "../../components/DataTable";
import { AccessChip, AccessSelect } from "../../components/AccessControls";
import {
  deleteReferenceType,
  type ReferenceTypeDetail,
  updateReferenceType,
} from "../../data/api";
import { useOwnedReferenceTypes, useReferenceTypes } from "../../data/hooks";
import {
  type AccessLevel,
  fromAccessLevel,
  toAccessLevel,
} from "../../data/visibility";
import { INSTRUCTIONS_DISCLOSURE } from "./CreateReferenceTypeDialog";
import { formatDate } from "../../theme/hootFormat";

interface Props {
  refreshKey: number;
}

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

export default function ReferenceTypesTab({ refreshKey }: Props) {
  const {
    data: visible,
    loading: visibleLoading,
    error: visibleError,
    refetch: refetchVisible,
  } = useReferenceTypes();
  const {
    data: owned,
    loading: ownedLoading,
    error: ownedError,
    refetch: refetchOwned,
  } = useOwnedReferenceTypes();
  const [editing, setEditing] = useState<ReferenceTypeDetail | null>(null);
  const [deleting, setDeleting] = useState<ReferenceTypeDetail | null>(null);

  useEffect(() => {
    refetchVisible();
    refetchOwned();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const refreshBoth = () => {
    refetchVisible();
    refetchOwned();
  };

  const rows = useMemo<TypeRow[]>(() => {
    const builtins: TypeRow[] = (visible ?? [])
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
    const mine: TypeRow[] = (owned ?? []).map((t) => ({
      id: `row:${t.type}`,
      type: t.type,
      display_name: t.display_name,
      value_hint: t.value_hint,
      owner: t.owner_name ?? t.owner_id,
      created_at: t.created_at,
      shadowed_by_builtin: t.shadowed_by_builtin,
      detail: t,
    }));
    return [...builtins, ...mine];
  }, [visible, owned]);

  const columns = useMemo<GridColDef<TypeRow>[]>(
    () => [
      {
        field: "type",
        headerName: "Slug",
        width: 200,
        renderCell: ({ row }) => (
          <Stack direction="row" alignItems="center" spacing={1}>
            <Box component="span" sx={{ fontFamily: "monospace" }}>
              {row.type}
            </Box>
            {row.shadowed_by_builtin && (
              <Chip label="shadowed by built-in" size="small" color="warning" />
            )}
          </Stack>
        ),
      },
      { field: "display_name", headerName: "Name", width: 180 },
      { field: "value_hint", headerName: "Value hint", flex: 1, minWidth: 240 },
      {
        field: "access",
        headerName: "Access",
        width: 110,
        sortable: false,
        filterable: false,
        renderCell: ({ row }) =>
          row.detail ? (
            <AccessChip pair={row.detail} />
          ) : (
            <Chip label="Built-in" size="small" />
          ),
      },
      { field: "owner", headerName: "Owner", width: 150 },
      {
        field: "created_at",
        headerName: "Created",
        width: 116,
        valueFormatter: (value) => (value ? formatDate(value as string) : "—"),
      },
      {
        field: "actions",
        headerName: "",
        width: 96,
        sortable: false,
        filterable: false,
        renderCell: ({ row }) =>
          row.detail ? (
            <Stack direction="row">
              <IconButton
                size="small"
                onClick={() => setEditing(row.detail)}
                aria-label={`Edit ${row.display_name}`}
              >
                <EditOutlined fontSize="small" />
              </IconButton>
              <IconButton
                size="small"
                onClick={() => setDeleting(row.detail)}
                aria-label={`Delete ${row.display_name}`}
              >
                <DeleteOutline fontSize="small" />
              </IconButton>
            </Stack>
          ) : null,
      },
    ],
    [],
  );

  const error = visibleError ?? ownedError;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {visibleLoading || ownedLoading ? (
        <CircularProgress />
      ) : (
        <DataTable rows={rows} columns={columns} fillHeight />
      )}

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
      {deleting && (
        <DeleteReferenceTypeDialog
          referenceType={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            refreshBoth();
          }}
        />
      )}
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
        ...fromAccessLevel(access),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save reference type");
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit =
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
          <AccessSelect value={access} onChange={setAccess} disabled={submitting} />
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

function DeleteReferenceTypeDialog({
  referenceType,
  onClose,
  onDeleted,
}: {
  referenceType: ReferenceTypeDetail;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  const handleDelete = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await deleteReferenceType(referenceType.type);
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete reference type");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onClose={handleClose} fullWidth maxWidth="xs">
      <DialogTitle>Delete reference type</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Delete <b>{referenceType.display_name}</b> (<code>{referenceType.type}</code>
          )? This cannot be undone. A type still used by references cannot be
          deleted.
        </DialogContentText>
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          color="error"
          variant="contained"
          onClick={handleDelete}
          disabled={submitting}
          startIcon={submitting ? <CircularProgress size={16} /> : undefined}
        >
          Delete
        </Button>
      </DialogActions>
    </Dialog>
  );
}
