import FolderZipOutlined from "@mui/icons-material/FolderZipOutlined";
import CloudOutlined from "@mui/icons-material/CloudOutlined";
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
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { type KeyboardEvent, Suspense, lazy, useEffect, useRef, useState } from "react";
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
  parentPath,
  sortEntries,
  zipLabel,
} from "./cloudFiles";
import FileRowActions from "./FileRowActions";
import { FileKindIcon, spokenKind } from "./fileKind";
import { APPEAR_SX, type Origin, PULSE_SX, type Travel, arriveSx, centreOf, travelBetween } from "./motion";
import { PathCrumbs } from "./PathCrumbs";
import { type FolderState, useCloudFilesShown, useFolder } from "./useCloudFiles";

/** Empty folders, in the PM's words (explorer list, item 9). */
export const EMPTY_FOLDER = "This folder is empty.";
export const EMPTY_AGENT_FOLDER = "Nothing here yet. Files your agent makes appear here.";

/** While the box wakes after Wake it (the shared spec's words). */
export const WAKING_WORDS = { title: "Waking your cloud…", line: "This takes about a minute" } as const;

/** The filter's fixed words (explorer list, items 3 and 9). */
export const FILTER_WORDS = {
  label: "Filter this folder",
  clear: "Clear filter",
  none: (filter: string) => `No files match ‘${filter}’.`,
  /** While more of the folder isn't loaded, the filter says it only looked at what is (as Console). */
  partial: (loaded: number) => `Filtering the first ${loaded} loaded. Show more to include the rest.`,
} as const;

/** The rows a filter keeps: those whose name or label holds it, ignoring case. Only what's loaded. */
export function filterEntries(entries: readonly CloudFileEntry[], filter: string): CloudFileEntry[] {
  const wanted = filter.trim().toLowerCase();
  if (!wanted) return [...entries];
  return entries.filter(
    (entry) => entry.name.toLowerCase().includes(wanted) || entryTitle(entry).toLowerCase().includes(wanted),
  );
}

/** Whether a key press came from somewhere the person is typing. */
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** Read by screen readers, not shown (as MUI's `visuallyHidden`, which is not a direct dependency here). */
const visuallyHidden = {
  border: 0,
  clip: "rect(0 0 0 0)",
  height: "1px",
  margin: "-1px",
  overflow: "hidden",
  padding: 0,
  position: "absolute",
  whiteSpace: "nowrap",
  width: "1px",
} as const;

/** Grey rows the shape of the list while a folder loads, so nothing jumps when it arrives. */
function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <Box aria-busy="true" sx={{ px: 2, py: 1 }} data-testid="folder-skeleton">
      <Box component="span" sx={visuallyHidden}>
        Loading files…
      </Box>
      {Array.from({ length: rows }, (_, index) => (
        <Stack
          key={index}
          direction="row"
          alignItems="center"
          spacing={1.5}
          aria-hidden
          // MUI's slow 2 s pulse (the spec's), held still at 0.7 under reduced motion.
          sx={{
            height: 37,
            "@media (prefers-reduced-motion: reduce)": {
              "& .MuiSkeleton-root": { animation: "none", opacity: 0.7 },
            },
          }}
        >
          <Skeleton variant="rounded" width={20} height={20} />
          <Skeleton variant="text" sx={{ flex: 1, maxWidth: `${60 - index * 7}%` }} />
          <Skeleton variant="text" width={56} />
          <Skeleton variant="text" width={88} sx={{ display: { xs: "none", sm: "block" } }} />
        </Stack>
      ))}
    </Box>
  );
}

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
  // Kept across folders for the visit, in memory only (never stored): someone
  // looking for what changed, or for "menu", keeps looking that way.
  const [order, setOrder] = useState<EntryOrder>("name");
  const [filter, setFilter] = useState("");
  // Whether the open folder was reached from the keyboard, so its first row takes focus (as Console).
  const [byKeyboard, setByKeyboard] = useState(false);
  // Which way the last folder change went, for the list's short slide.
  const [travel, setTravel] = useState<Travel>("none");
  const openFolder = (path: string, fromKeyboard = false) => {
    setByKeyboard(fromKeyboard);
    setTravel(travelBetween(folder, path));
    setFolder(path);
  };

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
                  onClick={() => openFolder("")}
                >
                  <ListItemIcon sx={{ minWidth: 32 }}>
                    <FileKindIcon entry={{ name: "", kind: "folder" }} open={folder === ""} />
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
                      onClick={() => openFolder(entry.name)}
                    >
                      <ListItemIcon sx={{ minWidth: 32 }}>
                        <FileKindIcon
                          entry={entry}
                          open={folder === entry.name || (folder ?? "").startsWith(`${entry.name}/`)}
                        />
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
                  onOpenFolder={openFolder}
                  focusOnLoad={byKeyboard}
                  travel={travel}
                  order={order}
                  onOrder={setOrder}
                  filter={filter}
                  onFilter={setFilter}
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
      <Box sx={{ border: 1, borderColor: "divider", borderRadius: 2 }}>
        <SkeletonRows rows={6} />
      </Box>
    );
  if (state.kind === "resting" || state.kind === "waking")
    return (
      <Stack spacing={1.5} alignItems="center" sx={{ border: 1, borderColor: "divider", borderRadius: 2, py: 6 }}>
        {state.kind === "resting" ? (
          <NightsStayOutlined color="action" />
        ) : (
          <CloudOutlined color="primary" sx={PULSE_SX} aria-hidden data-testid="waking-cloud" />
        )}
        <Typography variant="subtitle1">
          {state.kind === "resting" ? "Your cloud is resting" : WAKING_WORDS.title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {state.kind === "resting"
            ? RESTING_EXPLANATION
            : WAKING_WORDS.line}
        </Typography>
        {state.kind === "resting" && (
          <Button variant="contained" onClick={onWake}>
            Wake it
          </Button>
        )}
      </Stack>
    );
  if (state.kind === "error") return <Alert severity="error">{state.message}</Alert>;
  // The list fades in once it's there, after waking as after loading.
  return <Box sx={APPEAR_SX}>{children}</Box>;
}

function FolderList({
  path,
  rootEntries,
  onOpenFolder,
  order,
  onOrder,
  filter,
  onFilter,
  focusOnLoad = false,
  travel = "none",
}: {
  path: string;
  rootEntries: readonly CloudFileEntry[];
  /** Open a folder; `fromKeyboard` puts focus on its first row once it loads. */
  onOpenFolder: (path: string, fromKeyboard?: boolean) => void;
  focusOnLoad?: boolean;
  /** How the list arrived: a short slide into a folder or back up, or a fade. */
  travel?: Travel;
  order: EntryOrder;
  onOrder: (order: EntryOrder) => void;
  filter: string;
  onFilter: (filter: string) => void;
}) {
  const folder = useFolder(path, path !== "");
  const state: FolderState = path === "" ? { kind: "ready", entries: [...rootEntries], more: false } : folder.state;
  const [asking, setAsking] = useState<string | null>(null);
  const [caches, setCaches] = useState(false);
  // The file shown in the preview modal, over this list; the list stays as it is underneath.
  const [shown, setShown] = useState<CloudFileEntry | null>(null);
  // Where the preview opens from: the clicked row's centre.
  const [origin, setOrigin] = useState<Origin | null>(null);
  const preview = (entry: CloudFileEntry, from: Element | null | undefined) => {
    setOrigin(centreOf(from));
    setShown(entry);
  };
  const sorted = state.kind === "ready" ? sortEntries(state.entries, path === "", order) : [];
  const agentsOwn = path !== "" && rootEntries.some((entry) => entry.name === path && entry.agent !== undefined);
  const rows = filterEntries(sorted, filter);
  const theme = useTheme();
  // Touch screens and phone widths get the "⋯" menu: there's no hover there.
  const noHover = useMediaQuery("(hover: none)");
  const narrow = useMediaQuery(theme.breakpoints.down("sm"));
  const compact = noHover || narrow;

  // The list is one grid with a single Tab stop (roving focus): arrows move
  // the current row, Enter opens it (the name is a button), Backspace goes up.
  const [current, setCurrent] = useState(0);
  const names = useRef<(HTMLButtonElement | null)[]>([]);
  const filterBox = useRef<HTMLInputElement>(null);
  const at = Math.min(current, Math.max(rows.length - 1, 0));
  const moveTo = (index: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, index));
    setCurrent(next);
    names.current[next]?.focus();
  };
  const onListKey = (event: KeyboardEvent) => {
    if (typingIn(event.target) && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (event.key === "ArrowDown") moveTo(at + 1);
    else if (event.key === "ArrowUp") moveTo(at - 1);
    else if (event.key === "Home") moveTo(0);
    else if (event.key === "End") moveTo(rows.length - 1);
    else if (event.key === "Backspace" && path !== "") onOpenFolder(parentPath(path), true);
    else return;
    event.preventDefault();
  };
  // Opened from the keyboard: the first row takes focus as soon as the list is there.
  const ready = state.kind === "ready";
  useEffect(() => {
    if (focusOnLoad && ready) names.current[0]?.focus();
  }, [focusOnLoad, ready]);

  // `/` jumps to the filter from anywhere on the page, but never while typing
  // in a field, and not while the preview is open over the list.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (typingIn(event.target) || shown) return;
      event.preventDefault();
      filterBox.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [shown]);
  return (
    <Stack sx={{ flex: 1, minHeight: 0, ...arriveSx(travel) }}>
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
          <TextField
            size="small"
            placeholder={FILTER_WORDS.label}
            value={filter}
            onChange={(event) => onFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && filter) {
                event.stopPropagation();
                onFilter("");
              } else if (event.key === "ArrowDown" && rows.length > 0) {
                event.preventDefault();
                moveTo(0);
              }
            }}
            inputRef={filterBox}
            sx={{ width: { xs: "100%", sm: 200 } }}
            slotProps={{ htmlInput: { "aria-label": FILTER_WORDS.label, "aria-keyshortcuts": "/" } }}
          />
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
      {state.kind === "loading" && <SkeletonRows />}
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
          <Table
            size="small"
            stickyHeader
            role="grid"
            aria-label={path === "" ? "All files" : `Files in ${path}`}
            aria-rowcount={rows.length + 1}
            onKeyDown={onListKey}
          >
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
                <TableCell align="right" sx={{ width: compact ? 56 : 132 }}>
                  <Box component="span" sx={visuallyHidden}>
                    Actions
                  </Box>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((entry, index) => {
                const target = childPath(path, entry.name);
                const isCurrent = index === at;
                return (
                  <TableRow
                    key={entry.name}
                    hover
                    selected={isCurrent && rows.length > 1}
                    sx={{
                      "& .cloud-row-actions": {
                        opacity: 0,
                        transition: "opacity 150ms ease-out",
                        "@media (prefers-reduced-motion: reduce)": { transition: "none" },
                      },
                      "&:hover .cloud-row-actions, &:focus-within .cloud-row-actions": { opacity: 1 },
                    }}
                  >
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
                          ref={(node: HTMLButtonElement | null) => {
                            names.current[index] = node;
                          }}
                          tabIndex={isCurrent ? 0 : -1}
                          onFocus={() => setCurrent(index)}
                          sx={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 1,
                            textAlign: "left",
                            borderRadius: 0.5,
                            "&:focus-visible": { outline: 2, outlineStyle: "solid", outlineColor: "primary.main", outlineOffset: 2 },
                          }}
                          onClick={(event) =>
                            entry.kind === "file"
                              ? preview(entry, event.currentTarget)
                              : entry.collapsed
                                ? setAsking(entry.name)
                                : // A click from Enter or Space has no mouse clicks behind it.
                                  onOpenFolder(target, event.detail === 0)
                          }
                        >
                          <FileKindIcon entry={entry} />
                          {entryTitle(entry)}
                          {/* Colour is never the only signal: the kind is read after the name. */}
                          <Box component="span" sx={visuallyHidden}>
                            {`, ${spokenKind(entry)}`}
                          </Box>
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
                    <TableCell align="right" sx={{ py: 0 }}>
                      <FileRowActions
                        entry={entry}
                        path={target}
                        compact={compact}
                        tabbable={isCurrent}
                        onPreview={() => preview(entry, names.current[index])}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {state.entries.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              {path === "" ? EMPTY.noFiles : agentsOwn ? EMPTY_AGENT_FOLDER : EMPTY_FOLDER}
            </Typography>
          )}
          {state.entries.length > 0 && rows.length === 0 && (
            <Stack direction="row" alignItems="center" spacing={1} sx={{ p: 2 }}>
              <Typography variant="body2" color="text.secondary">
                {FILTER_WORDS.none(filter.trim())}
              </Typography>
              <Button size="small" onClick={() => onFilter("")}>
                {FILTER_WORDS.clear}
              </Button>
            </Stack>
          )}
          {state.more && (
            <Stack direction="row" alignItems="center" spacing={1} sx={{ p: 1 }}>
              {/* The filter only sees what's loaded: say so, rather than read more on each key. */}
              {filter.trim() !== "" && (
                <Typography variant="caption" color="text.secondary" sx={{ pl: 1 }}>
                  {FILTER_WORDS.partial(state.entries.length)}
                </Typography>
              )}
              <Button size="small" onClick={() => void folder.loadMore()}>
                Show more
              </Button>
            </Stack>
          )}
        </Box>
      )}
      {shown && (
        <Suspense fallback={null}>
          <FilePreviewModal
          folder={path}
          entries={rows}
          entry={shown}
          origin={origin}
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


