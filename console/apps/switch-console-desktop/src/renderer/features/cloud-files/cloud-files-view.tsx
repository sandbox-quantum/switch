import {
  ChevronDown,
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  FolderArchive,
  FolderOpen,
  Moon,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { attachmentBlobType } from '@renderer/features/chats/components/attachment-blob-type';
import { ServerPage } from '@renderer/features/switch-servers/server-page';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';
import {
  agentFolder,
  type CloudFileEntry,
  type CloudFilesCode,
  cloudFilesMessage,
} from '@shared/core/cloud-files/cloud-files';
import {
  childPath,
  entryTitle,
  formatChanged,
  formatSize,
  pathCrumbs,
  sortEntries,
} from './cloud-files-format';
import { FileMarkdown, FileText } from './file-markdown';
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
  'What your agents have made in your cloud. Browse, preview and download; nothing here changes a file.';

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
  const root = useCloudFolder(serverId, '', visible);
  const [folder, setFolder] = useState<string | null>(null);
  const [file, setFile] = useState<{ path: string; entry: CloudFileEntry } | null>(null);

  // The folder to open first, once the top level is known: the `path` given, else
  // View files' agent folder (matched on its name, never its label), else the top level.
  useEffect(() => {
    if (folder !== null || root.state.kind !== 'ready') return;
    const given = openablePath(params.path);
    const own = params.agent ? agentFolder(root.state.entries, params.agent) : null;
    setFolder(given ?? (own ? own.name : ''));
  }, [folder, root.state, params.path, params.agent]);

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
          <div className="flex min-h-[480px] overflow-hidden rounded-lg border border-border">
            <nav
              aria-label="Folders"
              className="w-64 shrink-0 overflow-y-auto border-r border-border bg-background-1 p-2"
            >
              <FolderTree
                serverId={serverId}
                entries={root.state.entries}
                parent=""
                selected={folder}
                onSelect={(path) => {
                  setFolder(path);
                  setFile(null);
                }}
              />
            </nav>
            <section className="flex min-w-0 flex-1 flex-col">
              {file ? (
                <FilePreview
                  serverId={serverId}
                  path={file.path}
                  entry={file.entry}
                  onClose={() => setFile(null)}
                />
              ) : (
                folder !== null && (
                  <FolderList
                    key={folder}
                    serverId={serverId}
                    path={folder}
                    rootEntries={root.state.entries}
                    onOpenFolder={setFolder}
                    onOpenFile={(path, entry) => setFile({ path, entry })}
                  />
                )
              )}
            </section>
          </div>
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
      <div className="flex items-center gap-2 text-sm text-foreground-muted">
        <Spinner /> Opening your cloud files…
      </div>
    );
  if (state.kind === 'resting' || state.kind === 'waking')
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-6 py-12 text-center">
        <Moon className="size-6 text-foreground-muted" aria-hidden />
        <div>
          <p className="text-sm font-medium text-foreground">
            {state.kind === 'resting' ? 'Your cloud is resting' : 'Waking your cloud…'}
          </p>
          <p className="mt-1 text-xs text-foreground-muted">
            {state.kind === 'resting'
              ? 'It sleeps when no agent is working. Wake it to see your files; it counts as awake time.'
              : 'This usually takes a minute or two. Your files show here as soon as it’s up.'}
          </p>
        </div>
        {state.kind === 'resting' ? (
          <Button size="sm" onClick={onWake}>
            Wake it
          </Button>
        ) : (
          <Spinner />
        )}
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
            icon={<FolderOpen className="size-3.5 shrink-0" aria-hidden />}
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
  return (
    <li>
      <TreeRow
        label={entryTitle(entry)}
        active={selected === path}
        open={open}
        muted={entry.collapsed === true}
        onToggle={entry.collapsed ? undefined : () => setOpen((now) => !now)}
        onSelect={() => onSelect(path)}
        icon={
          open ? (
            <FolderOpen className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <Folder className="size-3.5 shrink-0" aria-hidden />
          )
        }
      />
      {open && children.state.kind === 'ready' && (
        <FolderTree
          serverId={serverId}
          entries={children.state.entries}
          parent={path}
          selected={selected}
          onSelect={onSelect}
        />
      )}
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
  const Chevron = open ? ChevronDown : ChevronRight;
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
        <Chevron className="size-3" />
      </button>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5" onClick={onSelect}>
        {icon}
        <span className="truncate">{label}</span>
      </button>
    </div>
  );
}

/** The open folder's files: name, size and when it changed, a page at a time. */
function FolderList({
  serverId,
  path,
  rootEntries,
  onOpenFolder,
  onOpenFile,
}: {
  serverId: string;
  path: string;
  rootEntries: readonly CloudFileEntry[];
  onOpenFolder: (path: string) => void;
  onOpenFile: (path: string, entry: CloudFileEntry) => void;
}) {
  const folder = useCloudFolder(serverId, path, path !== '');
  const state: CloudFolderState =
    path === '' ? { kind: 'ready', entries: [...rootEntries], more: false } : folder.state;
  const [asking, setAsking] = useState<string | null>(null);
  const [caches, setCaches] = useState(false);
  const [zipping, setZipping] = useState(false);
  const name = path.split('/').pop() || 'cloud-files';

  const zip = async () => {
    setZipping(true);
    try {
      const result = await rpc.cloudFiles.saveZip({ serverId, path, name, caches });
      if (!result.ok) showError(result.code);
    } finally {
      setZipping(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <Breadcrumb path={path} rootEntries={rootEntries} onOpen={onOpenFolder} />
        <div className="flex shrink-0 items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-foreground-muted">
            <Checkbox checked={caches} onCheckedChange={(on) => setCaches(on === true)} />
            Include caches
          </label>
          <Button variant="outline" size="sm" disabled={zipping} onClick={() => void zip()}>
            {zipping ? <Spinner /> : <FolderArchive className="size-3.5" aria-hidden />}
            Download as zip
          </Button>
        </div>
      </header>
      {state.kind === 'loading' && (
        <div className="flex items-center gap-2 p-4 text-sm text-foreground-muted">
          <Spinner /> Loading…
        </div>
      )}
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
          <table className="w-full table-fixed border-collapse text-left text-sm">
            <thead className="sticky top-0 bg-background text-xs text-foreground-muted">
              <tr>
                <th className="px-3 py-1.5 font-medium">Name</th>
                <th className="w-24 px-3 py-1.5 text-right font-medium">Size</th>
                <th className="w-32 px-3 py-1.5 text-right font-medium">Changed</th>
              </tr>
            </thead>
            <tbody>
              {sortEntries(state.entries, path === '').map((entry) => {
                const target = childPath(path, entry.name);
                return (
                  <tr key={entry.name} className="border-t border-border hover:bg-background-1">
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
                          className="flex max-w-full items-center gap-2 text-left"
                          onClick={() =>
                            entry.kind === 'file'
                              ? onOpenFile(target, entry)
                              : entry.collapsed
                                ? setAsking(entry.name)
                                : onOpenFolder(target)
                          }
                        >
                          {entry.kind === 'folder' ? (
                            <Folder className="size-4 shrink-0 text-foreground-muted" aria-hidden />
                          ) : (
                            <FileIcon
                              className="size-4 shrink-0 text-foreground-muted"
                              aria-hidden
                            />
                          )}
                          <span className="truncate">{entryTitle(entry)}</span>
                          {entry.collapsed && <Badge variant="secondary">Large folder</Badge>}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right text-foreground-muted">
                      {entry.kind === 'file' ? formatSize(entry.size) : ''}
                    </td>
                    <td className="px-3 py-1.5 text-right text-foreground-muted">
                      {formatChanged(entry.mtime)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {state.entries.length === 0 && (
            <p className="p-4 text-sm text-foreground-muted">This folder is empty.</p>
          )}
          {state.more && (
            <div className="p-3">
              <Button variant="ghost" size="sm" onClick={() => void folder.loadMore()}>
                Show more
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Breadcrumb({
  path,
  rootEntries,
  onOpen,
}: {
  path: string;
  rootEntries: readonly CloudFileEntry[];
  onOpen: (path: string) => void;
}) {
  const crumbs = pathCrumbs(path);
  const top = rootEntries.find((entry) => entry.name === crumbs[0]?.name);
  return (
    <nav aria-label="Folder path" className="flex min-w-0 items-center gap-1 text-sm">
      <button
        type="button"
        className="shrink-0 text-foreground-muted hover:text-foreground"
        onClick={() => onOpen('')}
      >
        All files
      </button>
      {crumbs.map((crumb, index) => (
        <span key={crumb.path} className="flex min-w-0 items-center gap-1">
          <ChevronRight className="size-3 shrink-0 text-foreground-muted" aria-hidden />
          <button
            type="button"
            className={cn(
              'truncate',
              index === crumbs.length - 1
                ? 'text-foreground'
                : 'text-foreground-muted hover:text-foreground'
            )}
            onClick={() => onOpen(crumb.path)}
          >
            {index === 0 && top ? entryTitle(top) : crumb.name}
          </button>
        </span>
      ))}
    </nav>
  );
}

type Preview =
  | { kind: 'loading' }
  | { kind: 'image'; url: string }
  | { kind: 'text' | 'markdown'; text: string }
  | { kind: 'download' }
  | { kind: 'error'; code: CloudFilesCode };

/**
 * One file: shown inside Console if it's one of the four safe image types,
 * text or Markdown, otherwise offered for download only. An image's bytes go
 * into a Blob typed by `attachmentBlobType`, so nothing else can sit there.
 */
function FilePreview({
  serverId,
  path,
  entry,
  onClose,
}: {
  serverId: string;
  path: string;
  entry: CloudFileEntry;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<Preview>({ kind: 'loading' });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    let current = true;
    void rpc.cloudFiles
      .preview({ serverId, path, name: entry.name, size: entry.size })
      .then((result) => {
        if (!current) return;
        if (!result.ok) return setPreview({ kind: 'error', code: result.code });
        const value = result.value;
        if (value.kind === 'image') {
          const bytes = Uint8Array.from(atob(value.data), (char) => char.charCodeAt(0));
          url = URL.createObjectURL(
            new Blob([bytes], { type: attachmentBlobType(value.mimeType) })
          );
          setPreview({ kind: 'image', url });
        } else setPreview(value);
      });
    return () => {
      current = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [serverId, path, entry.name, entry.size]);

  const save = async () => {
    setSaving(true);
    try {
      const result = await rpc.cloudFiles.saveFile({ serverId, path, name: entry.name });
      if (!result.ok) showError(result.code);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{entry.name}</p>
          <p className="text-xs text-foreground-muted">
            {formatSize(entry.size)} · changed {formatChanged(entry.mtime)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? <Spinner /> : <Download className="size-3.5" aria-hidden />}
            Download
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Close preview" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {preview.kind === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-foreground-muted">
            <Spinner /> Loading the preview…
          </div>
        )}
        {preview.kind === 'image' && (
          <img
            src={preview.url}
            alt={entry.name}
            className="max-h-[70vh] max-w-full rounded-md border border-border object-contain"
          />
        )}
        {preview.kind === 'text' && <FileText text={preview.text} />}
        {preview.kind === 'markdown' && <FileMarkdown text={preview.text} />}
        {preview.kind === 'download' && (
          <p className="text-sm text-foreground-muted">
            There’s no preview for this kind of file. Download it to open it on your computer.
          </p>
        )}
        {preview.kind === 'error' && (
          <p role="alert" className="text-sm text-destructive">
            {cloudFilesMessage(preview.code)}
          </p>
        )}
      </div>
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
