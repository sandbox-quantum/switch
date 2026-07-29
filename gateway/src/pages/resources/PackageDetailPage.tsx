import ArrowBack from "@mui/icons-material/ArrowBack";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import {
  Alert,
  Box,
  Button,
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
  type PackageDetail,
  fetchPackage,
  updatePackage,
} from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { AccessChip, AccessSelect } from "../../components/AccessControls";
import {
  type AccessLevel,
  fromAccessLevel,
  toAccessLevel,
} from "../../data/visibility";
import { EM_DASH, MONO_SX, formatDateTime } from "../../theme/hootFormat";
import DeleteResourceDialog from "./DeleteResourceDialog";
import PackageMembersSection from "./PackageMembersSection";
import ResourceAttachmentsSection from "./ResourceAttachmentsSection";

export default function PackageDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [pkg, setPkg] = useState<PackageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    fetchPackage(id).then((p) => {
      if (cancelled) return;
      if (p) setPkg(p);
      else setFetchError("Package not found");
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

  if (fetchError || !pkg || !id) {
    return (
      <Box>
        <Button startIcon={<ArrowBack />} onClick={() => navigate("/resources")}>
          Back to resources
        </Button>
        <Alert severity="error" sx={{ mt: 2 }}>
          {fetchError ?? "Package not found"}
        </Alert>
      </Box>
    );
  }

  const canMutate =
    !!user && (user.id === pkg.owner_id || user.role === "admin");

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <IconButton
          onClick={() => navigate("/resources?tab=packages")}
          size="small"
        >
          <ArrowBack />
        </IconButton>
        <Typography variant="h5" sx={{ flexGrow: 1 }}>
          {pkg.name || "Package"}
        </Typography>
        <AccessChip pair={pkg} />
      </Stack>

      <Stack spacing={4}>
        <InfoSection pkg={pkg} />
        <Divider />
        <EditFieldsSection
          pkg={pkg}
          canMutate={canMutate}
          onSaved={(updated) => setPkg(updated)}
        />
        <Divider />
        <PackageMembersSection packageId={id} canMutate={canMutate} />
        <Divider />
        <ResourceAttachmentsSection kind="package" resourceId={id} />
        {canMutate && (
          <>
            <Divider />
            <DangerSection onDelete={() => setDeleteOpen(true)} />
          </>
        )}
      </Stack>

      <DeleteResourceDialog
        open={deleteOpen}
        kind="package"
        resourceId={id}
        resourceLabel={pkg.name || id}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => navigate("/resources?tab=packages")}
      />
    </Box>
  );
}

function InfoSection({ pkg }: { pkg: PackageDetail }) {
  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Info
      </Typography>
      <Typography variant="body2" color="text.secondary">
        <strong>Owner:</strong>{" "}
        {pkg.owner_name ? (
          pkg.owner_name
        ) : pkg.owner_id ? (
          <Box component="span" sx={MONO_SX}>
            {pkg.owner_id}
          </Box>
        ) : (
          <Box component="span" sx={{ color: "text.secondary" }}>
            {EM_DASH}
          </Box>
        )}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        <strong>Created:</strong> {formatDateTime(pkg.created_at)}
      </Typography>
    </Stack>
  );
}

function EditFieldsSection({
  pkg,
  canMutate,
  onSaved,
}: {
  pkg: PackageDetail;
  canMutate: boolean;
  onSaved: (updated: PackageDetail) => void;
}) {
  const [name, setName] = useState(pkg.name);
  const [description, setDescription] = useState(pkg.description);
  const [instructions, setInstructions] = useState(pkg.instructions);
  const [access, setAccess] = useState<AccessLevel>(toAccessLevel(pkg));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(
    () =>
      name !== pkg.name ||
      description !== pkg.description ||
      instructions !== pkg.instructions ||
      access !== toAccessLevel(pkg),
    [name, description, instructions, access, pkg],
  );

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updatePackage(pkg.id, {
        name,
        description,
        instructions,
        ...fromAccessLevel(access),
      });
      onSaved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

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
        helperText="Short summary. Shown in lists."
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
        Delete package
      </Button>
    </Stack>
  );
}
