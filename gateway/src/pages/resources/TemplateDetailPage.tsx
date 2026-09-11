import ArrowBack from "@mui/icons-material/ArrowBack";
import ContentCopy from "@mui/icons-material/ContentCopy";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import Download from "@mui/icons-material/Download";
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
  type TemplateDetail,
  fetchTemplate,
  fetchTemplateContent,
  updateTemplate,
} from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { EM_DASH, MONO_SX, formatDateTime } from "../../theme/hootFormat";
import DeleteTemplateDialog from "./DeleteTemplateDialog";
import TemplateFindings from "./TemplateFindings";
import { formatBytes, templateFilename } from "./templateFormat";
import { useTemplateValidation } from "./useTemplateValidation";

const LIST_URL = "/resources?tab=templates";

export default function TemplateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [template, setTemplate] = useState<TemplateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    fetchTemplate(id).then((t) => {
      if (cancelled) return;
      if (t) setTemplate(t);
      else setFetchError("Template not found");
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

  if (fetchError || !template || !id) {
    return (
      <Box>
        <Button startIcon={<ArrowBack />} onClick={() => navigate("/resources")}>
          Back to resources
        </Button>
        <Alert severity="error" sx={{ mt: 2 }}>
          {fetchError ?? "Template not found"}
        </Alert>
      </Box>
    );
  }

  const canMutate =
    !!user && (user.id === template.owner_id || user.role === "admin");

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <IconButton onClick={() => navigate(LIST_URL)} size="small">
          <ArrowBack />
        </IconButton>
        <Typography variant="h5" sx={{ flexGrow: 1 }}>
          {template.name || "Template"}
        </Typography>
        <Chip size="small" variant="outlined" label={template.kind} />
      </Stack>

      <Stack spacing={4}>
        <InfoSection template={template} />
        <Divider />
        <DocumentSection
          template={template}
          canMutate={canMutate}
          onSaved={setTemplate}
        />
        {canMutate && (
          <>
            <Divider />
            <DangerSection onDelete={() => setDeleteOpen(true)} />
          </>
        )}
      </Stack>

      <DeleteTemplateDialog
        open={deleteOpen}
        templateId={id}
        templateLabel={template.name || id}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => navigate(LIST_URL)}
      />
    </Box>
  );
}

function InfoSection({ template }: { template: TemplateDetail }) {
  return (
    <Stack spacing={1}>
      <Typography
        variant="overline"
        sx={{ color: "text.secondary", display: "block" }}
      >
        Info
      </Typography>
      <InfoLine
        label="Owner"
        value={template.owner_name ?? template.owner_id}
        mono={!template.owner_name}
      />
      <InfoLine label="Revision" value={String(template.version)} />
      <InfoLine label="Size" value={formatBytes(template.size_bytes)} />
      <InfoLine label="Created" value={formatDateTime(template.created_at)} />
      <InfoLine label="Updated" value={formatDateTime(template.updated_at)} />
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

function DocumentSection({
  template,
  canMutate,
  onSaved,
}: {
  template: TemplateDetail;
  canMutate: boolean;
  onSaved: (updated: TemplateDetail) => void;
}) {
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);
  const [kind, setKind] = useState(template.kind);
  const [content, setContent] = useState(template.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Only while the document is editable — a reader cannot act on the findings.
  const { result: validation, checking } = useTemplateValidation(content, {
    enabled: canMutate,
  });

  const dirty = useMemo(
    () =>
      name !== template.name ||
      description !== template.description ||
      kind !== template.kind ||
      content !== template.content,
    [name, description, kind, content, template],
  );

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateTemplate(template.id, {
        name,
        description,
        kind,
        content,
      });
      onSaved(updated);
      setContent(updated.content);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  // Both of these go back to the server for the document rather than using the
  // copy on screen, so what you download is what is stored even if the editor
  // has unsaved edits in it.
  const withStoredDocument = async (use: (text: string) => Promise<void> | void) => {
    setExportError(null);
    setCopied(false);
    try {
      await use(await fetchTemplateContent(template.id));
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "Failed to fetch document");
    }
  };

  const handleCopy = () =>
    withStoredDocument(async (text) => {
      // Absent outside a secure context, where the bare property access would
      // read as "failed to fetch document" rather than the truth.
      if (!navigator.clipboard) {
        throw new Error("Copying needs a secure connection (HTTPS).");
      }
      await navigator.clipboard.writeText(text);
      setCopied(true);
    });

  const handleDownload = () =>
    withStoredDocument((text) => {
      const url = URL.createObjectURL(
        new Blob([text], { type: "application/x-yaml" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = templateFilename(template.name);
      document.body.appendChild(a);
      a.click();
      a.remove();
      // The click only queues the download; revoking in the same tick can pull
      // the blob out from under a browser that has not read it yet.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography
          variant="overline"
          sx={{ color: "text.secondary", flexGrow: 1 }}
        >
          Document
        </Typography>
        <Button size="small" startIcon={<ContentCopy />} onClick={handleCopy}>
          Copy
        </Button>
        <Button size="small" startIcon={<Download />} onClick={handleDownload}>
          Download
        </Button>
      </Stack>
      {exportError && <Alert severity="error">{exportError}</Alert>}
      {copied && <Alert severity="success">Document copied to the clipboard.</Alert>}
      {!canMutate && (
        // Said outright rather than left to the greyed-out fields. Every
        // template on the server is visible to everyone, so reading someone
        // else's is the ordinary case here, not the exception it is for the
        // resources next door — and a disabled field on its own only tells you
        // something is wrong once you have already tried to type in it.
        <Alert severity="info">
          This template belongs to {template.owner_name ?? "another user"}. You
          can copy or download it; only its owner or an admin can change it.
        </Alert>
      )}
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
        helperText="Shown in the catalogue, and searched alongside the name."
      />
      <TextField
        label="Kind"
        value={kind}
        onChange={(e) => setKind(e.target.value)}
        disabled={!canMutate || saving}
        sx={{ maxWidth: 320 }}
      />
      <TextField
        label="Document"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        disabled={!canMutate || saving}
        multiline
        minRows={16}
        slotProps={{ input: { sx: { fontFamily: "monospace" } } }}
        helperText="Saving a changed document bumps the revision."
      />
      <TemplateFindings result={validation} checking={checking} />
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
      <Typography
        variant="overline"
        sx={{ color: "error.main", display: "block" }}
      >
        Danger zone
      </Typography>
      <Button
        variant="outlined"
        color="error"
        startIcon={<DeleteOutline />}
        onClick={onDelete}
        sx={{ alignSelf: "flex-start" }}
      >
        Delete template
      </Button>
    </Stack>
  );
}
