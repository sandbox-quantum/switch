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
  TableSortLabel,
  Typography,
} from "@mui/material";
import { Suspense, lazy, useEffect, useState } from "react";
import { Link as RouterLink, useSearchParams } from "react-router";
import { zipUrl } from "../../data/cloudFiles";
import { EM_DASH, absoluteTitle, formatRelative } from "../../theme/hootFormat";
import { EMPTY, RESTING_EXPLANATION } from "../agents/cloud/peopleWords";
import {
  type CloudFileEntry,
  type EntryOrder,
  agentFolder,
  childPath,
  entryTitle,
  formatSize,
  openablePath,
  sortEntries,
  zipLabel,
} from "./cloudFiles";
import { PathCrumbs } from "./PathCrumbs";
import { type FolderState, useCloudFilesShown, useFolder } from "./useCloudFiles";

// The preview modal, with its Markdown and highlighting packages, loads only when a file is opened.
const FilePreviewModal = lazy(() => import("./FilePreviewModal").then((module) => ({ default: module.FilePreviewModal })));

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
  const [missing, setMissing] = useState(false);
  // Kept across folders: someone looking for what changed keeps looking that way.
  const [order, setOrder] = useState<EntryOrder>("name");

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
          What your agents have made in your cloud. Browse, preview and download. Nothing here changes a file.
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
            {/* On a phone there's no room for the side list; the path and the list reach every folder. */}
            <Box
              component="nav"
              aria-label="Folders"
              sx={{ width: 240, flexShrink: 0, borderRight: 1, borderColor: "divider", display: { xs: "none", sm: "block" } }}
            >
              <List dense>
                <ListItemButton
                  selected={folder === ""}
                  onClick={() => setFolder("")}
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
                      onClick={() => setFolder(entry.name)}
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
              {folder !== null && (
                <FolderList
                  key={folder}
                  path={folder}
                  rootEntries={root.state.entries}
                  onOpenFolder={(path) => setFolder(path)}
                  order={order}
                  onOrder={setOrder}
                />
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
            ? RESTING_EXPLANATION
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
  order,
  onOrder,
}: {
  path: string;
  rootEntries: readonly CloudFileEntry[];
  onOpenFolder: (path: string) => void;
  order: EntryOrder;
  onOrder: (order: EntryOrder) => void;
}) {
  const folder = useFolder(path, path !== "");
  const state: FolderState = path === "" ? { kind: "ready", entries: [...rootEntries], more: false } : folder.state;
  const [asking, setAsking] = useState<string | null>(null);
  const [caches, setCaches] = useState(false);
  // The file shown in the preview modal, over this list; the list stays as it is underneath.
  const [shown, setShown] = useState<CloudFileEntry | null>(null);
  const sorted = state.kind === "ready" ? sortEntries(state.entries, path === "", order) : [];
  return (
    <Stack sx={{ flex: 1, minHeight: 0 }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        useFlexGap
        spacing={1}
        sx={{ px: 2, py: 1, borderBottom: 1, borderColor: "divider", flexWrap: "wrap" }}
      >
        <PathCrumbs path={path} rootEntries={rootEntries} onOpen={onOpenFolder} />
        <Stack direction="row" alignItems="center" useFlexGap spacing={1} sx={{ flexShrink: { xs: 1, sm: 0 }, minWidth: 0, flexWrap: "wrap" }}>
          <FormControlLabel
            control={<Checkbox size="small" checked={caches} onChange={(event) => setCaches(event.target.checked)} />}
            label={<Typography variant="caption">Include caches</Typography>}
          />
          {/* Already `attachment` from Core, so plain navigation saves it and nothing opens as a page. */}
          <Button size="small" variant="outlined" startIcon={<FolderZipOutlined />} href={zipUrl(path, caches)} download>
            {zipLabel(path)}
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
                <TableCell sortDirection={order === "name" ? "asc" : false}>
                  <TableSortLabel active={order === "name"} direction="asc" onClick={() => onOrder("name")}>
                    Name
                  </TableSortLabel>
                </TableCell>
                <TableCell align="right" sx={{ width: 100 }}>
                  Size
                </TableCell>
                <TableCell
                  align="right"
                  sortDirection={order === "changed" ? "desc" : false}
                  sx={{ width: 140, display: { xs: "none", sm: "table-cell" } }}
                >
                  <TableSortLabel
                    active={order === "changed"}
                    direction="desc"
                    onClick={() => onOrder("changed")}
                    aria-label="Changed, newest first"
                  >
                    Changed
                  </TableSortLabel>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sorted.map((entry) => {
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
                          data-cloud-file={entry.kind === "file" ? entry.name : undefined}
                          sx={{ display: "inline-flex", alignItems: "center", gap: 1, textAlign: "left" }}
                          onClick={() =>
                            entry.kind === "file"
                              ? setShown(entry)
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
                    <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                      {entry.kind === "file" ? formatSize(entry.size) : EM_DASH}
                    </TableCell>
                    <TableCell
                      align="right"
                      title={absoluteTitle(new Date(entry.mtime).toISOString())}
                      sx={{ display: { xs: "none", sm: "table-cell" } }}
                    >
                      {formatRelative(new Date(entry.mtime).toISOString())}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {state.entries.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              {path === "" ? EMPTY.noFiles : "This folder is empty."}
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
      {shown && (
        <Suspense fallback={null}>
          <FilePreviewModal
          folder={path}
          entries={sorted}
          entry={shown}
          rootEntries={rootEntries}
          onShow={setShown}
          onOpenFolder={onOpenFolder}
          onClose={() => setShown(null)}
          />
        </Suspense>
      )}
    </Stack>
  );
}


