import ChevronRight from "@mui/icons-material/ChevronRight";
import Close from "@mui/icons-material/Close";
import DownloadOutlined from "@mui/icons-material/DownloadOutlined";
import FolderOpenOutlined from "@mui/icons-material/FolderOpenOutlined";
import FolderOutlined from "@mui/icons-material/FolderOutlined";
import FolderZipOutlined from "@mui/icons-material/FolderZipOutlined";
import InsertDriveFileOutlined from "@mui/icons-material/InsertDriveFileOutlined";
import NightsStayOutlined from "@mui/icons-material/NightsStayOutlined";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  IconButton,
  Link,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { Link as RouterLink, useSearchParams } from "react-router";
import { readCloudFile, zipUrl } from "../../data/cloudFiles";
import { EM_DASH, absoluteTitle, formatRelative } from "../../theme/hootFormat";
import {
  type CloudFileEntry,
  CloudFilesError,
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  agentFolder,
  blobType,
  childPath,
  cloudFilesMessage,
  entryTitle,
  formatSize,
  looksLikeText,
  openablePath,
  pathCrumbs,
  previewKind,
  safeSuggestedName,
  sortEntries,
} from "./cloudFiles";
import { type FolderState, useCloudFilesShown, useFolder } from "./useCloudFiles";

/**
 * Your cloud files: the person's own box's workspaces, read-only, in Switch
 * web. Shown only with `hosted_v2` and `hosted_cloud_files` on and an agent
 * on a v2 box; otherwise nothing is asked. `?agent=` (View files) and
 * `?path=` come from the address bar, so they're untrusted: `agent` only
 * picks a folder from the listing, and `path` must be plain names.
 */
export default function CloudFilesPage() {
  const shown = useCloudFilesShown();
  const [params] = useSearchParams();
  const root = useFolder("", shown === true);
  const [folder, setFolder] = useState<string | null>(null);
  const [file, setFile] = useState<{ path: string; entry: CloudFileEntry } | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (folder !== null || root.state.kind !== "ready") return;
    const given = openablePath(params.get("path"));
    const asked = params.get("agent");
    const own = asked ? agentFolder(root.state.entries, asked) : null;
    if (asked && !own && !given) setMissing(true);
    setFolder(given ?? (own ? own.name : ""));
  }, [folder, root.state, params]);

  if (shown === null)
    return (
      <Stack direction="row" spacing={1} alignItems="center">
        <CircularProgress size={18} />
        <Typography variant="body2">Opening your cloud files…</Typography>
      </Stack>
    );
  if (!shown)
    return (
      <Stack spacing={2}>
        <Typography variant="h4" component="h1">
          Your cloud files
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Your cloud files show here once you have an agent in your cloud.{" "}
          <Link component={RouterLink} to="/agents">
            Go to Agents
          </Link>
        </Typography>
      </Stack>
    );

  return (
    <Stack spacing={2} sx={{ minHeight: 0 }}>
      <Box>
        <Typography variant="h4" component="h1">
          Your cloud files
        </Typography>
        <Typography variant="body2" color="text.secondary">
          What your agents have made in your cloud. Browse, preview and download; nothing here changes a file.
        </Typography>
        <Typography variant="caption" color="text.secondary">
          These are your agents’ files, so take care when sharing screenshots. On a shared computer, downloads stay
          in this browser’s download folder.
        </Typography>
      </Box>
      {missing && (
        <Alert severity="info" onClose={() => setMissing(false)}>
          That agent’s folder isn’t there, so here are all your cloud files.
        </Alert>
      )}
      <RootState state={root.state} onWake={() => void root.wake()}>
        {root.state.kind === "ready" && (
          <Stack
            direction="row"
            sx={{ minHeight: 480, border: 1, borderColor: "divider", borderRadius: 2, overflow: "hidden" }}
          >
            <Box component="nav" aria-label="Folders" sx={{ width: 240, flexShrink: 0, borderRight: 1, borderColor: "divider" }}>
              <List dense>
                <ListItemButton
                  selected={folder === ""}
                  onClick={() => {
                    setFolder("");
                    setFile(null);
                  }}
                >
                  <ListItemIcon sx={{ minWidth: 32 }}>
                    <FolderOpenOutlined fontSize="small" />
                  </ListItemIcon>
                  <ListItemText primary="All files" />
                </ListItemButton>
                {/* A cache folder isn't in the side list: the file list asks before opening it. */}
                {sortEntries(root.state.entries, true)
                  .filter((entry) => entry.kind === "folder" && !entry.collapsed)
                  .map((entry) => (
                    <ListItemButton
                      key={entry.name}
                      selected={folder === entry.name || (folder ?? "").startsWith(`${entry.name}/`)}
                      onClick={() => {
                        setFolder(entry.name);
                        setFile(null);
                      }}
                    >
                      <ListItemIcon sx={{ minWidth: 32 }}>
                        <FolderOutlined fontSize="small" />
                      </ListItemIcon>
                      <ListItemText primary={entryTitle(entry)} />
                    </ListItemButton>
                  ))}
              </List>
            </Box>
            <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
              {file ? (
                <FilePreview path={file.path} entry={file.entry} onClose={() => setFile(null)} />
              ) : (
                folder !== null && (
                  <FolderList
                    key={folder}
                    path={folder}
                    rootEntries={root.state.entries}
                    onOpenFolder={(path) => setFolder(path)}
                    onOpenFile={(path, entry) => setFile({ path, entry })}
                  />
                )
              )}
            </Box>
          </Stack>
        )}
      </RootState>
    </Stack>
  );
}

function RootState({
  state,
  onWake,
  children,
}: {
  state: FolderState;
  onWake: () => void;
  children: React.ReactNode;
}) {
  if (state.kind === "loading")
    return (
      <Stack direction="row" spacing={1} alignItems="center">
        <CircularProgress size={18} />
        <Typography variant="body2">Opening your cloud files…</Typography>
      </Stack>
    );
  if (state.kind === "resting" || state.kind === "waking")
    return (
      <Stack spacing={1.5} alignItems="center" sx={{ border: 1, borderColor: "divider", borderRadius: 2, py: 6 }}>
        <NightsStayOutlined color="action" />
        <Typography variant="subtitle1">
          {state.kind === "resting" ? "Your cloud is resting" : "Waking your cloud…"}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {state.kind === "resting"
            ? "It sleeps when no agent is working. Wake it to see your files; it counts as awake time."
            : "This usually takes a minute or two. Your files show here as soon as it’s up."}
        </Typography>
        {state.kind === "resting" ? (
          <Button variant="contained" onClick={onWake}>
            Wake it
          </Button>
        ) : (
          <CircularProgress size={20} />
        )}
      </Stack>
    );
  if (state.kind === "error") return <Alert severity="error">{state.message}</Alert>;
  return <>{children}</>;
}

function FolderList({
  path,
  rootEntries,
  onOpenFolder,
  onOpenFile,
}: {
  path: string;
  rootEntries: readonly CloudFileEntry[];
  onOpenFolder: (path: string) => void;
  onOpenFile: (path: string, entry: CloudFileEntry) => void;
}) {
  const folder = useFolder(path, path !== "");
  const state: FolderState = path === "" ? { kind: "ready", entries: [...rootEntries], more: false } : folder.state;
  const [asking, setAsking] = useState<string | null>(null);
  const [caches, setCaches] = useState(false);
  const crumbs = pathCrumbs(path);
  const top = rootEntries.find((entry) => entry.name === crumbs[0]?.name);

  return (
    <Stack sx={{ flex: 1, minHeight: 0 }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={1}
        sx={{ px: 2, py: 1, borderBottom: 1, borderColor: "divider" }}
      >
        <Stack direction="row" alignItems="center" spacing={0.5} component="nav" aria-label="Folder path" sx={{ minWidth: 0 }}>
          <Link component="button" underline="hover" onClick={() => onOpenFolder("")}>
            All files
          </Link>
          {crumbs.map((crumb, index) => (
            <Stack key={crumb.path} direction="row" alignItems="center" spacing={0.5} sx={{ minWidth: 0 }}>
              <ChevronRight fontSize="small" color="action" />
              <Link component="button" underline="hover" noWrap onClick={() => onOpenFolder(crumb.path)}>
                {index === 0 && top ? entryTitle(top) : crumb.name}
              </Link>
            </Stack>
          ))}
        </Stack>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ flexShrink: 0 }}>
          <FormControlLabel
            control={<Checkbox size="small" checked={caches} onChange={(event) => setCaches(event.target.checked)} />}
            label={<Typography variant="caption">Include caches</Typography>}
          />
          {/* Already `attachment` from Core, so plain navigation saves it and nothing opens as a page. */}
          <Button size="small" variant="outlined" startIcon={<FolderZipOutlined />} href={zipUrl(path, caches)} download>
            Download as zip
          </Button>
        </Stack>
      </Stack>
      {state.kind === "loading" && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 2 }}>
          <CircularProgress size={16} />
          <Typography variant="body2">Loading…</Typography>
        </Stack>
      )}
      {state.kind === "error" && (
        <Alert severity="error" sx={{ m: 2 }}>
          {state.message}
        </Alert>
      )}
      {(state.kind === "resting" || state.kind === "waking") && (
        <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
          Your cloud has gone to sleep. Open Your cloud files again to wake it.
        </Typography>
      )}
      {state.kind === "ready" && (
        <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell align="right" sx={{ width: 100 }}>
                  Size
                </TableCell>
                <TableCell align="right" sx={{ width: 140 }}>
                  Changed
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sortEntries(state.entries, path === "").map((entry) => {
                const target = childPath(path, entry.name);
                return (
                  <TableRow key={entry.name} hover>
                    <TableCell>
                      {asking === entry.name ? (
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Typography variant="body2">Large folder. Open anyway?</Typography>
                          <Button size="small" onClick={() => onOpenFolder(target)}>
                            Open
                          </Button>
                          <Button size="small" color="inherit" onClick={() => setAsking(null)}>
                            Cancel
                          </Button>
                        </Stack>
                      ) : (
                        <Link
                          component="button"
                          underline="hover"
                          color="inherit"
                          sx={{ display: "inline-flex", alignItems: "center", gap: 1, textAlign: "left" }}
                          onClick={() =>
                            entry.kind === "file"
                              ? onOpenFile(target, entry)
                              : entry.collapsed
                                ? setAsking(entry.name)
                                : onOpenFolder(target)
                          }
                        >
                          {entry.kind === "folder" ? (
                            <FolderOutlined fontSize="small" color="action" />
                          ) : (
                            <InsertDriveFileOutlined fontSize="small" color="action" />
                          )}
                          {entryTitle(entry)}
                          {entry.collapsed && <Chip size="small" label="Large folder" />}
                        </Link>
                      )}
                    </TableCell>
                    <TableCell align="right">{entry.kind === "file" ? formatSize(entry.size) : EM_DASH}</TableCell>
                    <TableCell align="right" title={absoluteTitle(new Date(entry.mtime).toISOString())}>
                      {formatRelative(new Date(entry.mtime).toISOString())}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {state.entries.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              This folder is empty.
            </Typography>
          )}
          {state.more && (
            <Box sx={{ p: 1 }}>
              <Button size="small" onClick={() => void folder.loadMore()}>
                Show more
              </Button>
            </Box>
          )}
        </Box>
      )}
    </Stack>
  );
}

type Preview =
  | { kind: "loading" }
  | { kind: "image"; url: string }
  | { kind: "text"; text: string }
  | { kind: "download" }
  | { kind: "error"; message: string };

/**
 * One file: one of the four safe image types in an `<img>` (its Blob typed by
 * `blobType`), text and Markdown as plain text, anything else download only.
 * A download goes through a temporary `<a download>`; nothing opens as a page.
 */
function FilePreview({ path, entry, onClose }: { path: string; entry: CloudFileEntry; onClose: () => void }) {
  const [preview, setPreview] = useState<Preview>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const kind = previewKind(entry.name, entry.size);
    if (kind.kind === "download") {
      setPreview({ kind: "download" });
      return;
    }
    let url: string | null = null;
    let current = true;
    const max = kind.kind === "image" ? IMAGE_PREVIEW_MAX_BYTES : TEXT_PREVIEW_MAX_BYTES;
    readCloudFile(path, max)
      .then((bytes) => {
        if (!current) return;
        if (kind.kind === "image") {
          url = URL.createObjectURL(new Blob([bytes], { type: blobType(kind.mimeType) }));
          setPreview({ kind: "image", url });
        } else if (looksLikeText(bytes)) setPreview({ kind: "text", text: new TextDecoder().decode(bytes) });
        else setPreview({ kind: "download" });
      })
      .catch((error: unknown) => {
        if (current)
          setPreview({
            kind: "error",
            message: cloudFilesMessage(error instanceof CloudFilesError ? error.code : "unknown"),
          });
      });
    return () => {
      current = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, entry.name, entry.size]);

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
      URL.revokeObjectURL(url);
    } catch (error) {
      setSaveError(cloudFilesMessage(error instanceof CloudFilesError ? error.code : "unknown"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack sx={{ flex: 1, minHeight: 0 }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ px: 2, py: 1, borderBottom: 1, borderColor: "divider" }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2" noWrap>
            {entry.name}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {formatSize(entry.size)} · changed {formatRelative(new Date(entry.mtime).toISOString())}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <Button
            size="small"
            variant="contained"
            startIcon={saving ? <CircularProgress size={14} /> : <DownloadOutlined />}
            disabled={saving}
            onClick={() => void save()}
          >
            Download
          </Button>
          <IconButton size="small" aria-label="Close preview" onClick={onClose}>
            <Close fontSize="small" />
          </IconButton>
        </Stack>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 2 }}>
        {saveError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {saveError}
          </Alert>
        )}
        {preview.kind === "loading" && <CircularProgress size={18} />}
        {preview.kind === "image" && (
          <Box
            component="img"
            src={preview.url}
            alt={entry.name}
            sx={{ maxWidth: "100%", maxHeight: "70vh", objectFit: "contain", border: 1, borderColor: "divider", borderRadius: 1 }}
          />
        )}
        {preview.kind === "text" && (
          <Box component="pre" sx={{ m: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "monospace", fontSize: 12 }}>
            {preview.text}
          </Box>
        )}
        {preview.kind === "download" && (
          <Typography variant="body2" color="text.secondary">
            There’s no preview for this kind of file. Download it to open it on your computer.
          </Typography>
        )}
        {preview.kind === "error" && <Alert severity="error">{preview.message}</Alert>}
      </Box>
    </Stack>
  );
}
