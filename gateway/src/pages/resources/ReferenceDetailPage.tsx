import ArrowBack from "@mui/icons-material/ArrowBack";
import {
  Box,
  Alert,
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
  type ReferenceDetail,
  loadReference,
  updateReference,
} from "../../data/api";
import { AccessChip, AccessSelect } from "../../components/AccessControls";
import {
  ACCESS_HELPERS_FOR_OTHERS,
  type AccessLevel,
  fromAccessLevel,
  toAccessLevel,
} from "../../data/visibility";
import { useReferenceTypes } from "../../data/hooks";
import { formatDateTime } from "../../theme/format";
import DeleteResourceDialog from "./DeleteResourceDialog";
import ResourceAttachmentsSection from "./ResourceAttachmentsSection";
import { referenceTypeLabel } from "./ReferencesTab";
import {
  DangerSection,
  DetailLoadFailed,
  DetailLoading,
  InPackagesSection,
  InfoLine,
  requiredHelper,
  useAfterTransfer,
  useResourceDetail,
} from "./detailParts";
import { CategoryChip } from "./resourceList";
import JsonValueForm from "./value_forms/JsonValueForm";
import UrlsValueForm from "./value_forms/UrlsValueForm";

const LIST_PATH = "/resources?tab=references";

export default function ReferenceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: types } = useReferenceTypes();
  const { data: ref, setData: setRef, error, loading, reload } = useResourceDetail(id, loadReference);
  const { afterTransfer, refreshNotice } = useAfterTransfer(id, loadReference, setRef, LIST_PATH);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (ref === null && loading) return <DetailLoading />;
  if (ref === null || !id) {
    return <DetailLoadFailed what="reference" listPath={LIST_PATH} error={error} onRetry={reload} />;
  }

  // Visibility-filtered, so it may miss a type this reference legitimately
  // has. Its only job is the value hint; every label comes from the server.
  const visibleTypeSpec = (types ?? []).find((t) => t.type === ref.type);
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
          {ref.name || "Reference"}
        </Typography>
        <CategoryChip label={referenceTypeLabel(ref)} />
        <AccessChip pair={ref} />
      </Stack>

      <Stack spacing={4}>
        <RefInfoSection ref_={ref} />
        <Divider />
        <EditFieldsSection
          ref_={ref}
          canEdit={ref.can_edit}
          canChangeAccess={ref.can_manage}
          valueHint={visibleTypeSpec?.value_hint}
          typeKnown={ref.type_display_name !== null}
          onSaved={(updated) => setRef(updated)}
        />
        <Divider />
        <InPackagesSection packageIds={ref.packages ?? []} />
        <Divider />
        <ResourceAttachmentsSection
          kind="reference"
          resourceId={id}
          resourceLabel={ref.name || id}
          hiddenRoomsCount={ref.hidden_rooms_count}
          canAttach
        />
        {ref.can_manage && (
          <>
            <Divider />
            <TransferOwnershipSection
              kind="reference"
              resourceId={id}
              resourceLabel={ref.name || id}
              ownerId={ref.owner_id}
              blockedReason={null}
              onTransferred={() => void afterTransfer()}
            />
          </>
        )}
        {ref.can_manage && (
          <>
            <Divider />
            <DangerSection what="reference" onDelete={() => setDeleteOpen(true)} />
          </>
        )}
      </Stack>

      {deleteOpen && (
        <DeleteResourceDialog
          kind="reference"
          resourceId={id}
          resourceLabel={ref.name || id}
          hiddenRoomsCount={ref.hidden_rooms_count}
          packageCount={(ref.packages ?? []).length}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => navigate(LIST_PATH)}
        />
      )}
    </Box>
  );
}

function RefInfoSection({ ref_ }: { ref_: ReferenceDetail }) {
  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Info
      </Typography>
      <InfoLine label="Type" value={referenceTypeLabel(ref_)} />
      {ref_.owner_name ? (
        <InfoLine label="Owner" value={ref_.owner_name} />
      ) : (
        <InfoLine label="Owner" value={ref_.owner_id} mono />
      )}
      <InfoLine label="Created" value={formatDateTime(ref_.created_at)} />
    </Stack>
  );
}

function EditFieldsSection({
  ref_,
  canEdit,
  canChangeAccess,
  valueHint,
  typeKnown,
  onSaved,
}: {
  ref_: ReferenceDetail;
  canEdit: boolean;
  canChangeAccess: boolean;
  valueHint: string | undefined;
  /** Whether a type of this slug exists at all, visible to the viewer or not. */
  typeKnown: boolean;
  onSaved: (updated: ReferenceDetail) => void;
}) {
  const [name, setName] = useState(ref_.name);
  const [description, setDescription] = useState(ref_.description);
  const [instructions, setInstructions] = useState(ref_.instructions);
  const [access, setAccess] = useState<AccessLevel>(toAccessLevel(ref_));
  const [value, setValue] = useState<Record<string, unknown>>(ref_.value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [valueValid, setValueValid] = useState(true);

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
        // Changing who may see or change it is the manager's alone.
        ...(access !== toAccessLevel(ref_) ? fromAccessLevel(access) : {}),
        value,
      });
      onSaved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  // Keyed on the stored value's shape, not on whether the type resolves: every
  // type shares the URL shape, and the type may simply not be visible to this
  // user. Reading the stored bag rather than the edit state keeps the choice of
  // editor fixed for the lifetime of an edit.
  const isUrlsValue = Array.isArray(ref_.value.urls);
  // What creating one requires, kept on an edit: a name, a description, and
  // a URL for a reference that points at them.
  const complete =
    name.trim() !== "" &&
    description.trim() !== "" &&
    (!isUrlsValue || (Array.isArray(value.urls) && value.urls.length > 0));

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
        {...requiredHelper(description, "Short, human-readable summary. Shown in lists.")}
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
      {isUrlsValue ? (
        <UrlsValueForm
          value={value}
          onChange={setValue}
          disabled={!canEdit || saving}
          helperText={
            valueHint ??
            (typeKnown
              ? "This reference's type is not visible to you. Enter one URL per line."
              : "No type of this name exists any more. Enter one URL per line.")
          }
        />
      ) : (
        <JsonValueForm
          value={value}
          onChange={setValue}
          disabled={!canEdit || saving}
          onValidityChange={setValueValid}
        />
      )}
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
          disabled={!(canEdit || canChangeAccess) || !dirty || !complete || saving || !valueValid}
          startIcon={saving ? <CircularProgress size={16} /> : undefined}
        >
          Save
        </Button>
      </Box>
    </Stack>
  );
}
