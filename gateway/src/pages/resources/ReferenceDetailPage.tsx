import ArrowBack from "@mui/icons-material/ArrowBack";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  type ReferenceDetail,
  fetchReference,
  updateReference,
} from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { AccessChip, AccessSelect } from "../../components/AccessControls";
import {
  type AccessLevel,
  fromAccessLevel,
  toAccessLevel,
} from "../../data/visibility";
import { usePackages, useReferenceTypes } from "../../data/hooks";
import { EM_DASH, MONO_SX, formatDateTime } from "../../theme/hootFormat";
import DeleteResourceDialog from "./DeleteResourceDialog";
import ResourceAttachmentsSection from "./ResourceAttachmentsSection";
import JsonValueForm from "./value_forms/JsonValueForm";
import { VALUE_FORMS } from "./value_forms";

export default function ReferenceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: types } = useReferenceTypes();
  const [ref, setRef] = useState<ReferenceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    fetchReference(id).then((r) => {
      if (cancelled) return;
      if (r) setRef(r);
      else setFetchError("Reference not found");
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (fetchError || !ref || !id) {
    return (
      <Box>
        <Button startIcon={<ArrowBack />} onClick={() => navigate("/resources")}>
          Back to resources
        </Button>
        <Alert severity="error" sx={{ mt: 2 }}>
          {fetchError ?? "Reference not found"}
        </Alert>
      </Box>
    );
  }

  const typeSpec = (types ?? []).find((t) => t.type === ref.type);
  const canMutate =
    !!user && (user.id === ref.owner_id || user.role === "admin");

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <IconButton
          onClick={() => navigate("/resources?tab=references")}
          size="small"
        >
          <ArrowBack />
        </IconButton>
        <Typography variant="h5" sx={{ flexGrow: 1 }}>
          {ref.name || "Reference"}
        </Typography>
        <Chip label={typeSpec?.display_name ?? ref.type} size="small" />
        <AccessChip pair={ref} />
      </Stack>

      <Stack spacing={4}>
        <RefInfoSection ref_={ref} typeLabel={typeSpec?.display_name} />
        <Divider />
        <EditFieldsSection
          ref_={ref}
          canMutate={canMutate}
          onSaved={(updated) => setRef(updated)}
        />
        <Divider />
        <InPackagesSection packageIds={ref.packages ?? []} />
        <Divider />
        <ResourceAttachmentsSection kind="reference" resourceId={id} />
        {canMutate && (
          <>
            <Divider />
            <DangerSection onDelete={() => setDeleteOpen(true)} />
          </>
        )}
      </Stack>

      <DeleteResourceDialog
        open={deleteOpen}
        kind="reference"
        resourceId={id}
        resourceLabel={ref.name || id}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => navigate("/resources?tab=references")}
      />
    </Box>
  );
}

function RefInfoSection({
  ref_,
  typeLabel,
}: {
  ref_: ReferenceDetail;
  typeLabel: string | undefined;
}) {
  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Info
      </Typography>
      <InfoLine label="Type" value={typeLabel ?? ref_.type} />
      {ref_.owner_name ? (
        <InfoLine label="Owner" value={ref_.owner_name} />
      ) : (
        <InfoLine label="Owner" value={ref_.owner_id} mono />
      )}
      <InfoLine label="Created" value={formatDateTime(ref_.created_at)} />
    </Stack>
  );
}

function InfoLine({
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

function EditFieldsSection({
  ref_,
  canMutate,
  onSaved,
}: {
  ref_: ReferenceDetail;
  canMutate: boolean;
  onSaved: (updated: ReferenceDetail) => void;
}) {
  const [name, setName] = useState(ref_.name);
  const [description, setDescription] = useState(ref_.description);
  const [instructions, setInstructions] = useState(ref_.instructions);
  const [access, setAccess] = useState<AccessLevel>(toAccessLevel(ref_));
  const [value, setValue] = useState<Record<string, unknown>>(ref_.value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(
    () =>
      name !== ref_.name ||
      description !== ref_.description ||
      instructions !== ref_.instructions ||
      access !== toAccessLevel(ref_) ||
      JSON.stringify(value) !== JSON.stringify(ref_.value),
    [name, description, instructions, access, value, ref_],
  );

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateReference(ref_.id, {
        name,
        description,
        instructions,
        ...fromAccessLevel(access),
        value,
      });
      onSaved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const ValueForm = VALUE_FORMS[ref_.type] ?? JsonValueForm;

  return (
    <Stack spacing={2}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Details
      </Typography>
      <TextField
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={!canMutate || saving}
      />
      <TextField
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={!canMutate || saving}
        multiline
        minRows={2}
        helperText="Short, human-readable summary. Shown in lists."
      />
      <TextField
        label="Instructions"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        disabled={!canMutate || saving}
        multiline
        minRows={6}
        helperText="Sent to agents on connect. Not shown in lists."
      />
      <ValueForm
        value={value}
        onChange={setValue}
        disabled={!canMutate || saving}
      />
      <AccessSelect
        value={access}
        onChange={setAccess}
        disabled={!canMutate || saving}
        sx={{ maxWidth: 320 }}
      />
      {error && <Alert severity="error">{error}</Alert>}
      <Box>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={!canMutate || !dirty || saving}
          startIcon={saving ? <CircularProgress size={16} /> : undefined}
        >
          Save
        </Button>
      </Box>
    </Stack>
  );
}

function InPackagesSection({ packageIds }: { packageIds: string[] }) {
  const navigate = useNavigate();
  const { data: allPackages } = usePackages();
  const nameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of allPackages ?? []) m[p.id] = p.name || p.description;
    return m;
  }, [allPackages]);
  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        In packages
      </Typography>
      {packageIds.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Not in any package.
        </Typography>
      ) : (
        <Stack direction="row" flexWrap="wrap" gap={0.5}>
          {packageIds.map((pid) => (
            <Chip
              key={pid}
              label={nameById[pid] ?? pid}
              size="small"
              variant="outlined"
              onClick={() => navigate(`/resources/packages/${pid}`)}
              sx={{ cursor: "pointer" }}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function DangerSection({ onDelete }: { onDelete: () => void }) {
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
        Delete reference
      </Button>
    </Stack>
  );
}
