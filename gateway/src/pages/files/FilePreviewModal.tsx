import ChevronLeft from "@mui/icons-material/ChevronLeft";
import ChevronRight from "@mui/icons-material/ChevronRight";
import Close from "@mui/icons-material/Close";
import DownloadOutlined from "@mui/icons-material/DownloadOutlined";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  IconButton,
  Stack,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { readCloudFile, wakeBox } from "../../data/cloudFiles";
import { absoluteTitle, formatRelative } from "../../theme/hootFormat";
import {
  type CloudFileEntry,
  CloudFilesError,
  DOWNLOAD_REVOKE_MS,
  IMAGE_PREVIEW_MAX_BYTES,
  type NoPreviewReason,
  TEXT_PREVIEW_MAX_BYTES,
  VIDEO_PREVIEW_MAX_BYTES,
  blobType,
  childPath,
  cloudFilesMessage,
  formatSize,
  looksLikeText,
  previewKind,
  safeSuggestedName,
  videoTypeFromBytes,
} from "./cloudFiles";
import { PathCrumbs } from "./PathCrumbs";
import { WAKE_FAILED_MESSAGE, WAKE_GIVE_UP_MS, WAKE_RETRY_MS } from "./useCloudFiles";
import { neighbourFiles } from "./previewFormat";
import { CodeView, CsvView, JsonView, MarkdownView, PlainText, VideoView } from "./previewViews";

type Preview =
  | { kind: "loading" }
  | { kind: "image" | "video"; url: string }
  | { kind: "text" | "markdown" | "json"; text: string }
  | { kind: "csv"; text: string; delimiter: "," | "\t" }
  | { kind: "code"; text: string; language: string }
  | { kind: "download"; reason: NoPreviewReason }
  /** The file was deleted while the list was open. */
  | { kind: "gone" }
  /** The box went to rest; Wake it wakes it and reads the same file again. */
  | { kind: "resting" }
  | { kind: "waking" }
  | { kind: "error"; message: string };

/** While waking, these mean "not up yet": read again shortly. */
const NOT_UP_YET = new Set(["box_resting", "files_elsewhere", "unreachable"]);

/** Whether a key press came from something that uses the arrow keys itself. */
function keepsArrows(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("video, input, textarea, select, [contenteditable='true']") !== null;
}

/**
 * One file in a modal over the explorer. The four safe image types and mp4 or
 * webm (bytes checked, Blob typed exactly) are shown; code, Markdown, JSON and
 * CSV are shown as text; anything else, or anything too big, offers Download.
 * Only the file shown is fetched: previous and next never prefetch. Esc, the
 * close button or the backdrop closes it, and focus goes back to the row of
 * the last file shown.
 */
export function FilePreviewModal({
  folder,
  entries,
  entry,
  rootEntries,
  onShow,
  onOpenFolder,
  onClose,
}: {
  /** The folder the file is in, box-relative. */
  folder: string;
  /** The folder's entries, in the order the list shows them. */
  entries: readonly CloudFileEntry[];
  entry: CloudFileEntry;
  rootEntries: readonly CloudFileEntry[];
  onShow: (entry: CloudFileEntry) => void;
  onOpenFolder: (path: string) => void;
  onClose: () => void;
}) {
  const path = childPath(folder, entry.name);
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("sm"));
  const [preview, setPreview] = useState<Preview>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  // Wake it: one ensure per modal, then this file read again every few seconds until the box answers.
  const woke = useRef(false);
  const wakeUntil = useRef<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // The list unmounts the modal on close, so focus goes back here, to the last file shown.
      returnTo.current?.focus();
    };
  }, []);
  // Moving to another file ends any wake loop for the last one.
  useEffect(() => {
    wakeUntil.current = null;
  }, [path]);
  const { previous, next } = neighbourFiles(entries, entry.name);

  // Focus goes back to the row of the last file shown, which may not be the one first clicked.
  useEffect(() => {
    returnTo.current =
      [...document.querySelectorAll<HTMLElement>("[data-cloud-file]")].find((row) => row.dataset.cloudFile === entry.name) ?? null;
  }, [entry.name]);

  useEffect(() => {
    const kind = previewKind(entry.name, entry.size);
    setSaveError(null);
    if (kind.kind === "download") {
      setPreview({ kind: "download", reason: kind.reason });
      return;
    }
    let url: string | null = null;
    let current = true;
    let retry: number | undefined;
    // Closing the modal or moving to another file stops this file's reads before the next range.
    const reading = new AbortController();
    setPreview(wakeUntil.current === null ? { kind: "loading" } : { kind: "waking" });
    const max = kind.kind === "image" ? IMAGE_PREVIEW_MAX_BYTES : kind.kind === "video" ? VIDEO_PREVIEW_MAX_BYTES : TEXT_PREVIEW_MAX_BYTES;
    readCloudFile(path, max, undefined, reading.signal)
      .then((bytes) => {
        if (!current) return;
        if (kind.kind === "image") {
          url = URL.createObjectURL(new Blob([bytes], { type: blobType(kind.mimeType) }));
          return setPreview({ kind: "image", url });
        }
        if (kind.kind === "video") {
          // The extension says video; the bytes must say the same, or it's download only.
          const type = videoTypeFromBytes(bytes, kind.mimeType);
          if (!type) return setPreview({ kind: "download", reason: "type" });
          url = URL.createObjectURL(new Blob([bytes], { type }));
          return setPreview({ kind: "video", url });
        }
        wakeUntil.current = null;
        if (!looksLikeText(bytes)) return setPreview({ kind: "download", reason: "type" });
        const text = new TextDecoder().decode(bytes);
        if (kind.kind === "csv") setPreview({ kind: "csv", text, delimiter: kind.delimiter });
        else if (kind.kind === "code") setPreview({ kind: "code", text, language: kind.language });
        else setPreview({ kind: kind.kind, text });
      })
      .catch((error: unknown) => {
        if (!current) return;
        const code = error instanceof CloudFilesError ? error.code : "unknown";
        if (wakeUntil.current !== null && NOT_UP_YET.has(code)) {
          if (Date.now() < wakeUntil.current) {
            retry = window.setTimeout(() => setAttempt((n) => n + 1), WAKE_RETRY_MS);
            return;
          }
          wakeUntil.current = null;
          return setPreview({ kind: "error", message: cloudFilesMessage("timeout") });
        }
        wakeUntil.current = null;
        if (code === "not_found") return setPreview({ kind: "gone" });
        if (code === "box_resting") return setPreview({ kind: "resting" });
        setPreview({ kind: "error", message: cloudFilesMessage(code) });
      });
    return () => {
      current = false;
      reading.abort();
      window.clearTimeout(retry);
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, entry.name, entry.size, attempt]);

  const wake = async () => {
    setPreview({ kind: "waking" });
    if (!woke.current) {
      woke.current = true;
      try {
        await wakeBox();
      } catch {
        if (mounted.current) setPreview({ kind: "error", message: WAKE_FAILED_MESSAGE });
        return;
      }
    }
    if (!mounted.current) return;
    wakeUntil.current = Date.now() + WAKE_GIVE_UP_MS;
    setAttempt((n) => n + 1);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const bytes = await readCloudFile(path);
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = safeSuggestedName(entry.name, "file");
      link.rel = "noopener";
      link.click();
      // Released a moment later: some Safari versions cancel a download whose
      // address is revoked straight after the click.
      window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_MS);
    } catch (error) {
      setSaveError(cloudFilesMessage(error instanceof CloudFilesError ? error.code : "unknown"));
    } finally {
      setSaving(false);
    }
  };

  const changed = new Date(entry.mtime).toISOString();
  return (
    <Dialog
      open
      onClose={onClose}
      fullScreen={phone}
      maxWidth={false}
      disableRestoreFocus
      aria-labelledby="cloud-file-preview-title"
      slotProps={{
        paper: { sx: phone ? {} : { width: "90vw", height: "90vh", maxWidth: "90vw", maxHeight: "90vh" } },
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        if (keepsArrows(event.target)) return;
        const target = event.key === "ArrowLeft" ? previous : next;
        if (!target) return;
        event.preventDefault();
        onShow(target);
      }}
    >
      <Typography id="cloud-file-preview-title" sx={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
        {entry.name}
      </Typography>
      <Stack
        direction="row"
        alignItems="flex-start"
        justifyContent="space-between"
        useFlexGap
        spacing={2}
        sx={{ px: 2, py: 1.5, borderBottom: 1, borderColor: "divider", flexShrink: 0, flexWrap: { xs: "wrap", sm: "nowrap" } }}
      >
        {/* On a phone the path takes its own line under the buttons, so it isn't squeezed. */}
        <Box sx={{ minWidth: 0, order: { xs: 2, sm: 0 }, flexBasis: { xs: "100%", sm: "auto" } }}>
          <PathCrumbs
            path={folder}
            rootEntries={rootEntries}
            onOpen={(target) => {
              onClose();
              onOpenFolder(target);
            }}
            fileName={entry.name}
          />
          <Typography variant="caption" color="text.secondary">
            {formatSize(entry.size)} · changed <span title={absoluteTitle(changed)}>{formatRelative(changed)}</span>
          </Typography>
        </Box>
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flexShrink: 0, ml: "auto" }}>
          <IconButton size="small" aria-label="Previous file" disabled={!previous} onClick={() => previous && onShow(previous)}>
            <ChevronLeft fontSize="small" />
          </IconButton>
          <IconButton size="small" aria-label="Next file" disabled={!next} onClick={() => next && onShow(next)}>
            <ChevronRight fontSize="small" />
          </IconButton>
          {preview.kind !== "gone" && (
            <Button
              size="small"
              variant="contained"
              startIcon={saving ? <CircularProgress size={14} /> : <DownloadOutlined />}
              disabled={saving}
              onClick={() => void save()}
            >
              Download
            </Button>
          )}
          <IconButton size="small" aria-label="Close preview" onClick={onClose}>
            <Close fontSize="small" />
          </IconButton>
        </Stack>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 2 }} data-preview-body="">
        {saveError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {saveError}
          </Alert>
        )}
        <PreviewBody preview={preview} name={entry.name} onWake={() => void wake()} />
      </Box>
    </Dialog>
  );
}

function PreviewBody({ preview, name, onWake }: { preview: Preview; name: string; onWake: () => void }) {
  switch (preview.kind) {
    case "loading":
      return <CircularProgress size={18} />;
    case "image":
      return (
        <Box
          component="img"
          src={preview.url}
          alt={name}
          sx={{ display: "block", mx: "auto", maxWidth: "100%", maxHeight: "100%", objectFit: "contain", border: 1, borderColor: "divider", borderRadius: 1 }}
        />
      );
    case "video":
      return <VideoView url={preview.url} label={name} />;
    case "code":
      return <CodeView text={preview.text} language={preview.language} />;
    case "json":
      return <JsonView text={preview.text} />;
    case "csv":
      return <CsvView text={preview.text} delimiter={preview.delimiter} />;
    case "markdown":
      return <MarkdownView text={preview.text} />;
    case "text":
      return <PlainText text={preview.text} />;
    case "download":
      return (
        <Typography variant="body2" color="text.secondary">
          {preview.reason === "too_large"
            ? "This file is too large to preview. Download it to open it on your computer."
            : "This file can’t be previewed here. Download it to open it on your computer."}
        </Typography>
      );
    case "gone":
      return (
        <Typography variant="body2" color="text.secondary">
          This file isn’t there any more.
        </Typography>
      );
    case "resting":
      return (
        <Stack spacing={1.5} alignItems="flex-start">
          <Typography variant="body2">Your cloud is resting.</Typography>
          <Typography variant="body2" color="text.secondary">
            Wake it to see this file; it counts as awake time.
          </Typography>
          <Button variant="contained" size="small" onClick={onWake}>
            Wake it
          </Button>
        </Stack>
      );
    case "waking":
      return (
        <Stack direction="row" spacing={1} alignItems="center">
          <CircularProgress size={18} />
          <Typography variant="body2">Waking your cloud… This usually takes a minute or two.</Typography>
        </Stack>
      );
    case "error":
      return <Alert severity="error">{preview.message}</Alert>;
  }
}
