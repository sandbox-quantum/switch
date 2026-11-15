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
  type DocumentDetail,
  loadDocument,
  updateDocument,
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
import ResourceAttachmentsSection from "./ResourceAttachmentsSection";
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

const LIST_PATH = "/resources?tab=documents";

export default function DocumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: doc, setData: setDoc, error, loading, reload } = useResourceDetail(id, loadDocument);
  const { afterTransfer, refreshNotice } = useAfterTransfer(id, loadDocument, setDoc, LIST_PATH);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (doc === null && loading) return <DetailLoading />;
  if (doc === null || !id) {
    return <DetailLoadFailed what="document" listPath={LIST_PATH} error={error} onRetry={reload} />;
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
          {doc.name || "Document"}
        </Typography>
        <AccessChip pair={doc} />
      </Stack>

      <Stack spacing={4}>
        <DocInfoSection doc={doc} />
        <Divider />
        <EditFieldsSection
          doc={doc}
          canEdit={doc.can_edit}
          canChangeAccess={doc.can_manage}
          onSaved={(updated) => setDoc(updated)}
        />
        <Divider />
        <InPackagesSection packageIds={doc.packages ?? []} />
        <Divider />
        <ResourceAttachmentsSection
          kind="document"
          resourceId={id}
          resourceLabel={doc.name || id}
          hiddenRoomsCount={doc.hidden_rooms_count}
          // A room's own document stays in its room.
          canAttach={doc.scope !== "room"}
        />
        {doc.can_transfer && (
          <>
            <Divider />
            <TransferOwnershipSection
              kind="document"
              resourceId={id}
              resourceLabel={doc.name || id}
              ownerId={doc.owner_id}
              blockedReason={null}
              onTransferred={() => void afterTransfer()}
            />
          </>
        )}
        {doc.can_manage && (
          <>
            <Divider />
            <DangerSection what="document" onDelete={() => setDeleteOpen(true)} />
          </>
        )}
      </Stack>

      {deleteOpen && (
        <DeleteResourceDialog
          kind="document"
          resourceId={id}
          resourceLabel={doc.name || id}
          hiddenRoomsCount={doc.hidden_rooms_count}
          packageCount={(doc.packages ?? []).length}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => navigate(LIST_PATH)}
        />
      )}
    </Box>
  );
}

function DocInfoSection({ doc }: { doc: DocumentDetail }) {
  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Info
      </Typography>
      {doc.owner_name ? (
        <InfoLine label="Owner" value={doc.owner_name} />
      ) : (
        <InfoLine label="Owner" value={doc.owner_id} mono />
      )}
      <InfoLine label="Created" value={formatDateTime(doc.created_at)} />
    </Stack>
  );
}

function EditFieldsSection({
  doc,
  canEdit,
  canChangeAccess,
  onSaved,
}: {
  doc: DocumentDetail;
  canEdit: boolean;
  canChangeAccess: boolean;
  onSaved: (updated: DocumentDetail) => void;
}) {
  const [name, setName] = useState(doc.name);
  const [description, setDescription] = useState(doc.description);
  const [instructions, setInstructions] = useState(doc.instructions);
  const [content, setContent] = useState(doc.content);
  const [access, setAccess] = useState<AccessLevel>(toAccessLevel(doc));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(
    () =>
      name !== doc.name ||
      description !== doc.description ||
      instructions !== doc.instructions ||
      content !== doc.content ||
      access !== toAccessLevel(doc),
    [name, description, instructions, content, access, doc],
  );

  // What creating one requires, kept on an edit.
  const complete = name.trim() !== "" && description.trim() !== "" && content.trim() !== "";

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateDocument(doc.id, {
        name,
        description,
        instructions,
        content,
        // Changing who may see or change it is the manager's alone.
        ...(access !== toAccessLevel(doc) ? fromAccessLevel(access) : {}),
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
        {...requiredHelper(description, "Short, human-readable summary. Shown in lists.")}
      />
      <TextField
        label="Instructions"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        disabled={!canEdit || saving}
        multiline
        minRows={4}
        helperText="Sent to agents on connect. Not shown in lists."
      />
      <TextField
        label="Content"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        disabled={!canEdit || saving}
        multiline
        minRows={12}
        slotProps={{ input: { sx: { fontFamily: "monospace" } } }}
        {...requiredHelper(content)}
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
