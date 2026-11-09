import { ArrowDown, ChevronRight, Cloud, FolderArchive, FolderOpen, Moon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { PEOPLE_WORDS } from '@renderer/features/cloud-agents/people-words';
import { useAnsweredFlags } from '@renderer/features/switch-buddy/use-this-computer';
import { ServerPage } from '@renderer/features/switch-servers/server-page';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { Kbd } from '@renderer/lib/ui/kbd';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';
import {
  agentFolder,
  type CloudFileEntry,
  type CloudFilesCode,
  cloudFilesMessage,
} from '@shared/core/cloud-files/cloud-files';
import { Breadcrumb } from './cloud-files-breadcrumb';
import {
  childPath,
  type EntryOrder,
  entryTitle,
  filterEntries,
  formatChanged,
  formatChangedFull,
  formatSize,
  NO_SIZE,
  parentPath,
  sortEntries,
  zipLabel,
} from './cloud-files-format';
import { slideDirection, useExplorerTransitions } from './explorer-motion';
import {
  EmptyFolder,
  EXPLORER_WORDS,
  FileKindIcon,
  ListSkeleton,
  NoMatch,
  partialFilterWords,
  RowActions,
  spokenName,
  TreeSkeleton,
} from './explorer-parts';
import { FilePreviewModal } from './file-preview-modal';
import { type CloudFolderState, useCloudFilesVisible, useCloudFolder } from './use-cloud-files';

type CloudFilesParams = {
  serverId: string;
  /** A folder to open first: plain names joined by `/`. Wins over `agent`. */
  path?: string;
  /** View files: the agent whose folder opens first (its definition name), matched once the top level answers. */
  agent?: string;
};

/** A `path` param a view may open: plain names joined by `/`, no `.`, `..`, empty part or leading slash. */
export function openablePath(path: unknown): string | null {
  if (typeof path !== 'string' || path === '' || path.length > 4096) return null;
  const parts = path.split('/');
  if (parts.length > 64) return null;
  return parts.every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes('\0'))
    ? path
    : null;
}

const DESCRIPTION =
  'What your agents have made in your cloud. Browse, preview and download. Nothing here changes a file.';

function useServerId(): string {
  return useParams('cloudFiles').params.serverId;
}

function CloudFilesTitlebar() {
  return (
    <ServerSectionTitlebar serverId={useServerId()} icon={FolderOpen} label="Your cloud files" />
  );
}

function showError(code: CloudFilesCode) {
  toast({ title: cloudFilesMessage(code), variant: 'destructive' });
}

/**
 * Your cloud files: the person's own box's workspaces, read-only. Hidden
 * (and none of its routes called) unless the server has hosted agents v2 and
 * `hosted_cloud_files` on and the person has a hosted agent; reached anyway,
 * it goes to Your Agents.
 */
function CloudFilesPanel() {
  const serverId = useServerId();
  const { params } = useParams('cloudFiles');
  const { navigate } = useNavigate();
  const visible = useCloudFilesVisible(serverId);
  // With hosted agents v2 off (a good flags read that says so), this page doesn't
  // exist: a saved view or an old link goes to Your Agents, as v1 has it.
  const flags = useAnsweredFlags(serverId);
  const v2Off = flags.answered && flags.readOk && flags.hostedV2 !== true;
  useEffect(() => {
    if (v2Off) navigate('serverAgents', { serverId });
  }, [v2Off, navigate, serverId]);
  const root = useCloudFolder(serverId, '', visible);
  const [folder, setFolder] = useState<string | null>(null);
  const motionSet = useExplorerTransitions();
  // Which way the last folder change went, for the list's slide.
  const [direction, setDirection] = useState<-1 | 0 | 1>(0);
  // Once the box has been woken here, the explorer fades in when it's up.
  const [woke, setWoke] = useState(false);
  useEffect(() => {
    if (root.state.kind === 'waking') setWoke(true);
  }, [root.state.kind]);
  // The filter and sort carry across folders for this visit, in memory only (never browser storage).
  const [filter, setFilter] = useState('');
  const [order, setOrder] = useState<EntryOrder>('name');
  // Whether the open folder was reached from the keyboard, so its first row takes focus.
  const [byKeyboard, setByKeyboard] = useState(false);
  const openFolder = (path: string, fromKeyboard = false) => {
    setByKeyboard(fromKeyboard);
    setDirection(slideDirection(folder, path));
    setFolder(path);
  };

  // The folder to open first, once the top level is known: the `path` given, else
  // View files' agent folder (matched on its name, never its label), else the top level.
  useEffect(() => {
    if (folder !== null || root.state.kind !== 'ready') return;
    const given = openablePath(params.path);
    const own = params.agent ? agentFolder(root.state.entries, params.agent) : null;
    setFolder(given ?? (own ? own.name : ''));
  }, [folder, root.state, params.path, params.agent]);

  if (v2Off) return null;
  if (!visible)
    return (
      <ServerPage width={1100} title="Your cloud files" description={DESCRIPTION}>
        <p className="text-sm text-foreground-muted">
          Your cloud files show here once you have an agent in your cloud.{' '}
          <Button variant="link" size="sm" onClick={() => navigate('serverAgents', { serverId })}>
            Go to Your Agents
          </Button>
        </p>
      </ServerPage>
    );

  return (
    <ServerPage width={1100} title="Your cloud files" description={DESCRIPTION}>
      <p className="-mt-4 text-xs text-foreground-muted">
        These are your agents’ files, so take care when sharing screenshots of them.
      </p>
      <RootState state={root.state} onWake={() => void root.wake()}>
        {root.state.kind === 'ready' && (
          <motion.div
            className="flex min-h-[480px] overflow-hidden rounded-lg border border-border"
            initial={woke ? { opacity: 0 } : false}
            animate={{ opacity: 1 }}
            transition={motionSet.enter}
          >
            <nav
              aria-label="Folders"
              className="w-64 shrink-0 overflow-y-auto border-r border-border bg-background-1 p-2 max-sm:hidden"
            >
              <FolderTree
                serverId={serverId}
                entries={root.state.entries}
                parent=""
                selected={folder}
                onSelect={(path) => openFolder(path)}
              />
            </nav>
            <section className="flex min-w-0 flex-1 flex-col">
              {folder !== null && (
                <motion.div
                  key={folder}
                  data-folder-motion={direction}
                  className="flex min-h-0 flex-1 flex-col"
                  initial={{ opacity: 0, x: direction * motionSet.slidePx }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={motionSet.enter}
                >
                  <FolderList
                    serverId={serverId}
                    path={folder}
                    rootEntries={root.state.entries}
                    onOpenFolder={openFolder}
                    filter={filter}
                    onFilter={setFilter}
                    order={order}
                    onOrder={setOrder}
                    focusOnLoad={byKeyboard}
                  />
                </motion.div>
              )}
            </section>
          </motion.div>
        )}
      </RootState>
    </ServerPage>
  );
}

/** The box's state around the explorer: finding it, resting (Wake it), waking, or a plain error. */
function RootState({
  state,
  onWake,
  children,
}: {
  state: CloudFolderState;
  onWake: () => void;
  children: ReactNode;
}) {
  if (state.kind === 'loading')
    return (
      <div className="flex min-h-[480px] overflow-hidden rounded-lg border border-border">
        <div className="w-64 shrink-0 border-r border-border bg-background-1 p-2 max-sm:hidden">
          <TreeSkeleton rows={4} />
        </div>
        <div className="min-w-0 flex-1">
          <ListSkeleton />
        </div>
      </div>
    );
  if (state.kind === 'waking') return <Waking />;
  if (state.kind === 'resting')
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-6 py-12 text-center">
        <Moon className="size-6 text-foreground-muted" aria-hidden />
        <div>
          <p className="text-sm font-medium text-foreground">Your cloud is resting</p>
          <p className="mt-1 text-xs text-foreground-muted">{PEOPLE_WORDS.restingExplanation}</p>
        </div>
        <Button size="sm" onClick={onWake}>
          Wake it
        </Button>
      </div>
    );
  if (state.kind === 'error')
    return (
      <p role="alert" className="text-sm text-destructive">
        {state.message}
      </p>
    );
  return <>{children}</>;
}

/**
 * After Wake it: a gentle pulsing cloud while the box starts (shown only once
 * the person has pressed Wake it). It's still under reduced motion.
 */
function Waking() {
  const motionSet = useExplorerTransitions();
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-3 rounded-lg border border-border px-6 py-12 text-center"
      data-explorer-waking=""
    >
      <motion.span
        aria-hidden
        className="text-foreground-muted"
        animate={
          motionSet.waking ? { opacity: [0.6, 1], scale: [1, 1.04] } : { opacity: 1, scale: 1 }
        }
        transition={motionSet.waking ?? { duration: 0 }}
      >
        <Cloud className="size-8" />
      </motion.span>
      <div>
        <p className="text-sm font-medium text-foreground">{EXPLORER_WORDS.waking}</p>
        <p className="mt-1 text-xs text-foreground-muted">{EXPLORER_WORDS.wakingNote}</p>
      </div>
    </div>
  );
}

/** One level of the folder tree; a folder's children load when it's opened. */
function FolderTree({
  serverId,
  entries,
  parent,
  selected,
  onSelect,
}: {
  serverId: string;
  entries: readonly CloudFileEntry[];
  parent: string;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const folders = sortEntries(entries, parent === '').filter((entry) => entry.kind === 'folder');
  return (
    <ul className={cn('flex flex-col gap-[1px]', parent && 'ml-3')}>
      {parent === '' && (
        <li>
          <TreeRow
            label="All files"
            active={selected === ''}
            open
            onSelect={() => onSelect('')}
            icon={<FileKindIcon entry={{ name: '', kind: 'folder' }} open className="size-3.5" />}
          />
        </li>
      )}
      {folders.map((entry) => (
        <TreeFolder
          key={entry.name}
          serverId={serverId}
          entry={entry}
          path={childPath(parent, entry.name)}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function TreeFolder({
  serverId,
  entry,
  path,
  selected,
  onSelect,
}: {
  serverId: string;
  entry: CloudFileEntry;
  path: string;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  // A cache folder stays closed in the tree; the list asks before opening it.
  const onWay = selected !== null && (selected === path || selected.startsWith(`${path}/`));
  const [open, setOpen] = useState(onWay && !entry.collapsed);
  useEffect(() => {
    if (onWay && !entry.collapsed) setOpen(true);
  }, [onWay, entry.collapsed]);
  const children = useCloudFolder(serverId, path, open);
  const motionSet = useExplorerTransitions();
  return (
    <li>
      <TreeRow
        label={entryTitle(entry)}
        active={selected === path}
        open={open}
        muted={entry.collapsed === true}
        onToggle={entry.collapsed ? undefined : () => setOpen((now) => !now)}
        onSelect={() => onSelect(path)}
        icon={<FileKindIcon entry={entry} open={open} className="size-3.5" />}
      />
      {open && children.state.kind === 'loading' && <TreeSkeleton />}
      {/* Opening and closing grow and shrink the children's height; only already-read rows move. */}
      <AnimatePresence initial={false}>
        {open && children.state.kind === 'ready' && (
          <motion.div
            key="children"
            data-tree-children={path}
            className="overflow-hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={motionSet.tree}
          >
            <FolderTree
              serverId={serverId}
              entries={children.state.entries}
              parent={path}
              selected={selected}
              onSelect={onSelect}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

function TreeRow({
  label,
  active,
  open,
  muted = false,
  onToggle,
  onSelect,
  icon,
}: {
  label: string;
  active: boolean;
  open: boolean;
  muted?: boolean;
  onToggle?: () => void;
  onSelect: () => void;
  icon: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex h-7 items-center gap-1 rounded-md pr-2 text-sm',
        active ? 'bg-background-3 text-foreground' : 'text-foreground-muted hover:bg-background-2',
        muted && !active && 'opacity-60'
      )}
    >
      <button
        type="button"
        aria-label={open ? `Close ${label}` : `Open ${label}`}
        className="flex size-5 shrink-0 items-center justify-center disabled:opacity-0"
        disabled={!onToggle}
        onClick={onToggle}
      >
        {/* One chevron that turns, rather than two that swap: 200 ms, and none under reduced motion. */}
        <ChevronRight
          data-open={open ? 'true' : 'false'}
          className={cn(
            'size-3 transition-transform duration-200 ease-out motion-reduce:transition-none',
            open && 'rotate-90'
          )}
        />
      </button>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5" onClick={onSelect}>
        {icon}
        <span className="truncate">{label}</span>
      </button>
    </div>
  );
}

/** Whether a key press is someone typing, so the explorer's own shortcuts leave it alone. */
function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('input, textarea, select, [contenteditable="true"], [role="menu"]') !== null
  );
}

/**
 * The open folder's files: name, size and when it changed, a page at a time.
 * A list you can drive from the keyboard: ↑ and ↓ move between rows (one tab
 * stop for the whole list), Enter opens, Backspace goes up a folder, and `/`
 * jumps to the filter. The filter and sort narrow only what's loaded, and live
 * in the panel's memory, never in browser storage.
 */
function FolderList({
  serverId,
  path,
  rootEntries,
  onOpenFolder,
  filter,
  onFilter,
  order,
  onOrder,
  focusOnLoad,
}: {
  serverId: string;
  path: string;
  rootEntries: readonly CloudFileEntry[];
  onOpenFolder: (path: string, fromKeyboard?: boolean) => void;
  filter: string;
  onFilter: (filter: string) => void;
  order: EntryOrder;
  onOrder: (order: EntryOrder) => void;
  /** Reached from the keyboard: put focus on the first row once it loads. */
  focusOnLoad: boolean;
}) {
  const folder = useCloudFolder(serverId, path, path !== '');
  const state: CloudFolderState =
    path === '' ? { kind: 'ready', entries: [...rootEntries], more: false } : folder.state;
  const [asking, setAsking] = useState<string | null>(null);
  const [caches, setCaches] = useState(false);
  const [zipping, setZipping] = useState(false);
  // The file shown in the preview modal, over this list; the list stays as it is underneath.
  const [shown, setShown] = useState<CloudFileEntry | null>(null);
  // Where the preview grows from: the centre of the row it was opened from.
  const [shownFrom, setShownFrom] = useState<{ x: number; y: number } | null>(null);
  const preview = (entry: CloudFileEntry, row: Element | null) => {
    const box = row?.getBoundingClientRect();
    setShownFrom(box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null);
    setShown(entry);
  };
  // The row holding the list's one tab stop.
  const [active, setActive] = useState(0);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLTableSectionElement>(null);
  const name = path.split('/').pop() || 'cloud-files';
  // An agent's own top-level folder says its files appear there as the agent makes them.
  const agentOwned =
    !path.includes('/') &&
    rootEntries.some((entry) => entry.name === path && entry.agent !== undefined);

  const sorted = state.kind === 'ready' ? sortEntries(state.entries, path === '', order) : [];
  const shownRows = filterEntries(sorted, filter);
  const filtering = filter.trim() !== '';
  const activeRow = Math.min(active, Math.max(shownRows.length - 1, 0));

  const rowButton = (index: number) =>
    listRef.current?.querySelector<HTMLElement>(`[data-row-index="${index}"]`) ?? null;
  const focusRow = (index: number) => {
    const next = Math.max(0, Math.min(index, shownRows.length - 1));
    setActive(next);
    rowButton(next)?.focus();
  };

  // Opened from the keyboard: the first row takes focus as soon as the list is there.
  const ready = state.kind === 'ready';
  useEffect(() => {
    if (focusOnLoad && ready)
      listRef.current?.querySelector<HTMLElement>('[data-row-index="0"]')?.focus();
  }, [focusOnLoad, ready]);

  // `/` jumps to the filter, unless someone is typing or the preview is open.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (typing(event.target) || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      filterRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const open = (entry: CloudFileEntry, fromKeyboard = false, row: Element | null = null) => {
    const target = childPath(path, entry.name);
    if (entry.kind === 'file') preview(entry, row);
    else if (entry.collapsed) setAsking(entry.name);
    else onOpenFolder(target, fromKeyboard);
  };

  const download = async (entry: CloudFileEntry) => {
    const result = await rpc.cloudFiles.saveFile({
      serverId,
      path: childPath(path, entry.name),
      name: entry.name,
    });
    if (!result.ok) showError(result.code);
  };

  const zip = async () => {
    setZipping(true);
    try {
      const result = await rpc.cloudFiles.saveZip({ serverId, path, name, caches });
      if (!result.ok) showError(result.code);
    } finally {
      setZipping(false);
    }
  };

  const onListKey = (event: KeyboardEvent<HTMLTableSectionElement>) => {
    if (typing(event.target)) return;
    const at = Number(
      (event.target as HTMLElement).closest('[data-row-index]')?.getAttribute('data-row-index') ??
        activeRow
    );
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRow(at + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusRow(at - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusRow(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusRow(shownRows.length - 1);
    } else if (
      event.key === 'Enter' &&
      (event.target as HTMLElement).hasAttribute('data-row-index')
    ) {
      event.preventDefault();
      const entry = shownRows[at];
      if (entry) open(entry, true, event.target as Element);
    } else if (event.key === 'Backspace' && path !== '') {
      event.preventDefault();
      onOpenFolder(parentPath(path), true);
    }
  };

  const sortHeader = (key: EntryOrder, label: string, className: string) => (
    <th
      className={className}
      aria-sort={order === key ? (key === 'name' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className={cn(
          'inline-flex items-center gap-1 rounded font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          order === key && 'text-foreground'
        )}
        aria-label={key === 'name' ? 'Name, A to Z' : 'Changed, newest first'}
        onClick={() => onOrder(key)}
      >
        {label}
        {order === key && <ArrowDown className="size-3" aria-hidden />}
      </button>
    </th>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <Breadcrumb path={path} rootEntries={rootEntries} onOpen={onOpenFolder} />
        <div className="flex shrink-0 items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-foreground-muted">
            <Checkbox checked={caches} onCheckedChange={(on) => setCaches(on === true)} />
            Include caches
          </label>
          <Button variant="outline" size="sm" disabled={zipping} onClick={() => void zip()}>
            {zipping ? <Spinner /> : <FolderArchive className="size-3.5" aria-hidden />}
            {/* At phone width the button is just its icon (still named for screen readers). */}
            <span className="max-sm:sr-only">{zipLabel(path)}</span>
          </Button>
        </div>
      </header>
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <div className="relative w-full max-w-xs">
          <SearchInput
            ref={filterRef}
            value={filter}
            onChange={(event) => onFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && filter) {
                event.preventDefault();
                event.stopPropagation();
                onFilter('');
              } else if (event.key === 'ArrowDown' && shownRows.length > 0) {
                event.preventDefault();
                focusRow(0);
              }
            }}
            placeholder={EXPLORER_WORDS.filter}
            aria-label={EXPLORER_WORDS.filter}
            aria-keyshortcuts="/"
            className="h-7 text-xs"
            containerClassName="w-full"
          />
          {/* The shortcut, inside the box while it's empty. */}
          {!filter && (
            <Kbd className="absolute top-1/2 right-2 -translate-y-1/2 border border-border bg-background-2 text-foreground-muted max-sm:hidden">
              /
            </Kbd>
          )}
        </div>
      </div>
      {state.kind === 'loading' && <ListSkeleton />}
      {state.kind === 'error' && (
        <p role="alert" className="p-4 text-sm text-destructive">
          {state.message}
        </p>
      )}
      {(state.kind === 'resting' || state.kind === 'waking') && (
        <p className="p-4 text-sm text-foreground-muted">
          Your cloud has gone to sleep. Open Your cloud files again to wake it.
        </p>
      )}
      {state.kind === 'ready' && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table
            role="grid"
            aria-label={`Files in ${path === '' ? 'All files' : name}`}
            className="w-full table-fixed border-collapse text-left text-sm"
          >
            <thead className="sticky top-0 bg-background text-xs text-foreground-muted">
              <tr>
                {sortHeader('name', 'Name', 'px-3 py-1.5')}
                <th className="w-24 px-3 py-1.5 text-right font-medium max-sm:hidden">Size</th>
                {sortHeader('changed', 'Changed', 'w-32 px-3 py-1.5 text-right max-sm:hidden')}
                <th className="w-28 px-2 py-1.5 max-sm:w-10">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody ref={listRef} onKeyDown={onListKey}>
              {shownRows.map((entry, index) => {
                const target = childPath(path, entry.name);
                const title = entryTitle(entry);
                return (
                  <tr
                    key={entry.name}
                    className="group border-t border-border focus-within:bg-background-2 hover:bg-background-1"
                  >
                    <td className="px-3 py-1.5">
                      {asking === entry.name ? (
                        <span className="flex items-center gap-2 text-xs">
                          Large folder. Open anyway?
                          <Button size="xs" onClick={() => onOpenFolder(target)}>
                            Open
                          </Button>
                          <Button size="xs" variant="ghost" onClick={() => setAsking(null)}>
                            Cancel
                          </Button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          data-row-index={index}
                          data-cloud-file={entry.kind === 'file' ? entry.name : undefined}
                          tabIndex={index === activeRow ? 0 : -1}
                          aria-label={spokenName(entry, title, entry.collapsed === true)}
                          className="focus-visible:ring-ring flex max-w-full items-center gap-2 rounded text-left focus-visible:ring-2 focus-visible:outline-none"
                          onFocus={() => setActive(index)}
                          onClick={(event) => open(entry, false, event.currentTarget)}
                        >
                          <FileKindIcon entry={entry} />
                          <span className="truncate">{title}</span>
                          {entry.collapsed && <Badge variant="secondary">Large folder</Badge>}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right text-foreground-muted max-sm:hidden">
                      {entry.kind === 'file' ? formatSize(entry.size) : NO_SIZE}
                    </td>
                    <td
                      className="px-3 py-1.5 text-right text-foreground-muted max-sm:hidden"
                      title={formatChangedFull(entry.mtime)}
                    >
                      {formatChanged(entry.mtime)}
                    </td>
                    <td className="px-2 py-1">
                      <RowActions
                        path={target}
                        isFile={entry.kind === 'file'}
                        label={title}
                        onPreview={() =>
                          preview(
                            entry,
                            listRef.current?.querySelector(`[data-row-index="${index}"]`) ?? null
                          )
                        }
                        onDownload={() => void download(entry)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {state.entries.length === 0 && <EmptyFolder agentFolder={agentOwned} />}
          {state.entries.length > 0 && filtering && shownRows.length === 0 && (
            <NoMatch filter={filter} onClear={() => onFilter('')} />
          )}
          {state.more && (
            <div className="flex items-center gap-3 p-3">
              <Button variant="ghost" size="sm" onClick={() => void folder.loadMore()}>
                Show more
              </Button>
              {filtering && (
                <span className="text-xs text-foreground-muted">
                  {partialFilterWords(state.entries.length)}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {shown && (
        <FilePreviewModal
          serverId={serverId}
          folder={path}
          entries={shownRows}
          entry={shown}
          rootEntries={rootEntries}
          onShow={setShown}
          onOpenFolder={onOpenFolder}
          onClose={() => setShown(null)}
          from={shownFrom}
        />
      )}
    </div>
  );
}

export const cloudFilesView = {
  WrapView: ({ children }: CloudFilesParams & { children: ReactNode }) => <>{children}</>,
  TitlebarSlot: CloudFilesTitlebar,
  MainPanel: CloudFilesPanel,
  canActivate: (params: unknown): GuardResult => {
    const value = (params ?? {}) as Partial<Record<keyof CloudFilesParams, unknown>>;
    if (typeof value.serverId !== 'string') return { ok: false, redirect: 'home' };
    if (
      (value.agent !== undefined && typeof value.agent !== 'string') ||
      (value.path !== undefined && typeof value.path !== 'string')
    )
      return { ok: false, redirect: 'home', discardParams: true };
    return { ok: true };
  },
} satisfies ViewDefinition<CloudFilesParams>;
