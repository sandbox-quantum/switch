import ArrowBack from "@mui/icons-material/ArrowBack";
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
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import TransferOwnershipSection from "../../components/TransferOwnershipSection";
import {
  type PackageDetail,
  loadPackage,
  updatePackage,
} from "../../data/api";
import { AccessChip, AccessSelect } from "../../components/AccessControls";
import {
  ACCESS_HELPERS_FOR_OTHERS,
  type AccessLevel,
  fromAccessLevel,
  toAccessLevel,
} from "../../data/visibility";
import { formatDateTime } from "../../theme/format";
import DeleteResourceDialog from "./DeleteResourceDialog";
import PackageMembersSection from "./PackageMembersSection";
import ResourceAttachmentsSection from "./ResourceAttachmentsSection";
import {
  DangerSection,
  DetailLoadFailed,
  DetailLoading,
  InfoLine,
  requiredHelper,
  useAfterTransfer,
  useResourceDetail,
} from "./detailParts";

const LIST_PATH = "/resources?tab=packages";

export default function PackageDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: pkg, setData: setPkg, error, loading, reload } = useResourceDetail(id, loadPackage);
  const { afterTransfer, refreshNotice } = useAfterTransfer(id, loadPackage, setPkg, LIST_PATH);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (pkg === null && loading) return <DetailLoading />;
  if (pkg === null || !id) {
    return <DetailLoadFailed what="package" listPath={LIST_PATH} error={error} onRetry={reload} />;
  }

  return (
    <Box>
      {refreshNotice}
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <IconButton
          onClick={() => navigate(LIST_PATH)}
          size="small"
          aria-label="Back"
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
          canEdit={pkg.can_edit}
          canChangeAccess={pkg.can_manage}
          onSaved={(updated) => setPkg(updated)}
        />
        <Divider />
        <PackageMembersSection packageId={id} canMutate={pkg.can_edit} />
        <Divider />
        <ResourceAttachmentsSection
          kind="package"
          resourceId={id}
          resourceLabel={pkg.name || id}
          hiddenRoomsCount={pkg.hidden_rooms_count}
          canAttach
        />
        {pkg.can_manage && (
          <>
            <Divider />
            <TransferOwnershipSection
              kind="package"
              resourceId={id}
              resourceLabel={pkg.name || id}
              ownerId={pkg.owner_id}
              blockedReason={null}
              onTransferred={() => void afterTransfer()}
            />
          </>
        )}
        {pkg.can_manage && (
          <>
            <Divider />
            <DangerSection what="package" onDelete={() => setDeleteOpen(true)} />
          </>
        )}
      </Stack>

      {deleteOpen && (
        <DeleteResourceDialog
          kind="package"
          resourceId={id}
          resourceLabel={pkg.name || id}
          hiddenRoomsCount={pkg.hidden_rooms_count}
          packageCount={0}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => navigate(LIST_PATH)}
        />
      )}
    </Box>
  );
}

function InfoSection({ pkg }: { pkg: PackageDetail }) {
  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Info
      </Typography>
      {pkg.owner_name ? (
        <InfoLine label="Owner" value={pkg.owner_name} />
      ) : (
        <InfoLine label="Owner" value={pkg.owner_id} mono />
      )}
      <InfoLine label="Created" value={formatDateTime(pkg.created_at)} />
    </Stack>
  );
}

function EditFieldsSection({
  pkg,
  canEdit,
  canChangeAccess,
  onSaved,
}: {
  pkg: PackageDetail;
  canEdit: boolean;
  canChangeAccess: boolean;
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

  // What creating one requires, kept on an edit.
  const complete = name.trim() !== "" && description.trim() !== "";

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updatePackage(pkg.id, {
        name,
        description,
        instructions,
        // Changing who may see or change it is the manager's alone.
        ...(access !== toAccessLevel(pkg) ? fromAccessLevel(access) : {}),
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
        disabled={!canEdit || saving}
        {...requiredHelper(name)}
      />
      <TextField
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={!canEdit || saving}
        multiline
        minRows={2}
        {...requiredHelper(description, "Short summary. Shown in lists.")}
      />
      <TextField
        label="Instructions"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        disabled={!canEdit || saving}
        multiline
        minRows={6}
        helperText="Sent to agents on connect. Not shown in lists."
      />
      <AccessSelect
        value={access}
        onChange={setAccess}
        disabled={!canChangeAccess || saving}
        helpers={canChangeAccess ? undefined : ACCESS_HELPERS_FOR_OTHERS}
        sx={{ maxWidth: 320 }}
      />
      {error && <Alert severity="error">{error}</Alert>}
      <Box>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={!(canEdit || canChangeAccess) || !dirty || !complete || saving}
          startIcon={saving ? <CircularProgress size={16} /> : undefined}
        >
          Save
        </Button>
      </Box>
    </Stack>
  );
}
