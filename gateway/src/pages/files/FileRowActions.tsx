import CheckOutlined from "@mui/icons-material/CheckOutlined";
import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import DownloadOutlined from "@mui/icons-material/DownloadOutlined";
import MoreHorizOutlined from "@mui/icons-material/MoreHorizOutlined";
import VisibilityOutlined from "@mui/icons-material/VisibilityOutlined";
import {
  Box,
  CircularProgress,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { type CloudFileEntry, CloudFilesError, cloudFilesMessage, entryTitle } from "./cloudFiles";
import { COPIED_MS, COPY_WORDS } from "./CopyPathButton";
import { saveCloudFile } from "./saveCloudFile";

/** The quick actions' fixed words (PM's explorer list, items 5 and 11), Copy path's from its button. */
export const ROW_ACTION_WORDS = {
  preview: "Preview",
  download: "Download",
  copy: COPY_WORDS.copy,
  more: "More actions",
  copied: COPY_WORDS.copied,
  copyFailed: COPY_WORDS.failed,
} as const;

/**
 * Preview, Download and Copy path on one row of Your cloud files. Laid out
 * as buttons that show on hover or keyboard focus, or, on touch screens and
 * narrow widths (`compact`), behind a "⋯" menu. Copy path copies the path
 * within Your cloud files only, never anything about the box. Download is
 * the preview's own safe download. Folders get Copy path alone.
 */
export default function FileRowActions({
  entry,
  path,
  compact,
  onPreview,
  tabbable = true,
}: {
  entry: CloudFileEntry;
  /** The entry's path within Your cloud files ("web-frontend/src/app.ts"). */
  path: string;
  compact: boolean;
  onPreview: () => void;
  /** Whether Tab reaches these buttons: only on the list's current row, so Tab leaves the list in one step. */
  tabbable?: boolean;
}) {
  const tab = tabbable ? undefined : -1;
  const file = entry.kind === "file";
  const title = entryTitle(entry);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const say = (ok: boolean, text: string) => {
    window.clearTimeout(timer.current);
    setNote({ ok, text });
    timer.current = window.setTimeout(() => setNote(null), COPIED_MS);
  };

  const copy = async () => {
    setMenu(null);
    try {
      await navigator.clipboard.writeText(path);
      say(true, ROW_ACTION_WORDS.copied);
    } catch {
      say(false, ROW_ACTION_WORDS.copyFailed);
    }
  };

  const download = async () => {
    setMenu(null);
    setSaving(true);
    try {
      await saveCloudFile(path, entry.name);
    } catch (error) {
      say(false, cloudFilesMessage(error instanceof CloudFilesError ? error.code : "unknown"));
    } finally {
      setSaving(false);
    }
  };

  const preview = () => {
    setMenu(null);
    onPreview();
  };

  // Spoken as it changes, and shown in place of nothing: the row keeps its height.
  const feedback = (
    <Typography
      role="status"
      variant="caption"
      color={note?.ok === false ? "error" : "success.main"}
      sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, whiteSpace: "nowrap" }}
    >
      {note?.ok && <CheckOutlined fontSize="inherit" aria-hidden />}
      {note?.text}
    </Typography>
  );

  if (compact)
    return (
      <Stack direction="row" alignItems="center" justifyContent="flex-end" spacing={0.5}>
        {feedback}
        <IconButton
          size="small"
          tabIndex={tab}
          aria-label={ROW_ACTION_WORDS.more}
          title={`${ROW_ACTION_WORDS.more} for ${title}`}
          aria-haspopup="menu"
          aria-expanded={menu ? "true" : undefined}
          onClick={(event) => {
            event.stopPropagation();
            setMenu(event.currentTarget);
          }}
        >
          {saving ? <CircularProgress size={16} /> : <MoreHorizOutlined fontSize="small" />}
        </IconButton>
        <Menu anchorEl={menu} open={menu !== null} onClose={() => setMenu(null)}>
          {file && (
            <MenuItem onClick={preview}>
              <ListItemIcon>
                <VisibilityOutlined fontSize="small" />
              </ListItemIcon>
              <ListItemText>{ROW_ACTION_WORDS.preview}</ListItemText>
            </MenuItem>
          )}
          {file && (
            <MenuItem onClick={() => void download()} disabled={saving}>
              <ListItemIcon>
                <DownloadOutlined fontSize="small" />
              </ListItemIcon>
              <ListItemText>{ROW_ACTION_WORDS.download}</ListItemText>
            </MenuItem>
          )}
          <MenuItem onClick={() => void copy()}>
            <ListItemIcon>
              <ContentCopyOutlined fontSize="small" />
            </ListItemIcon>
            <ListItemText>{ROW_ACTION_WORDS.copy}</ListItemText>
          </MenuItem>
        </Menu>
      </Stack>
    );

  return (
    <Stack direction="row" alignItems="center" justifyContent="flex-end" spacing={0.5}>
      {feedback}
      {/* Shown on the row's hover or focus (the row's own styles), always reachable by Tab. */}
      <Box className="cloud-row-actions" sx={{ display: "inline-flex", gap: 0.25 }}>
        {file && (
          <Tooltip title={ROW_ACTION_WORDS.preview}>
            <IconButton size="small" tabIndex={tab} aria-label={ROW_ACTION_WORDS.preview} onClick={preview}>
              <VisibilityOutlined fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {file && (
          <Tooltip title={ROW_ACTION_WORDS.download}>
            <span>
              <IconButton
                size="small"
                tabIndex={tab}
                aria-label={ROW_ACTION_WORDS.download}
                disabled={saving}
                onClick={() => void download()}
              >
                {saving ? <CircularProgress size={16} /> : <DownloadOutlined fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
        )}
        <Tooltip title={ROW_ACTION_WORDS.copy}>
          <IconButton size="small" tabIndex={tab} aria-label={ROW_ACTION_WORDS.copy} onClick={() => void copy()}>
            <ContentCopyOutlined fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    </Stack>
  );
}
