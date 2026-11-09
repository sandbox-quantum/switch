import { Check, Copy, Download, Eye, FolderOpen, MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { cn } from '@renderer/utils/utils';
import type { CloudFileEntry } from '@shared/core/cloud-files/cloud-files';
import { FILE_KIND_LOOK, FILE_KIND_WORDS, fileKind } from './file-kind';

/** The explorer's words that both apps share (the explorer spec). */
export const EXPLORER_WORDS = {
  empty: 'This folder is empty.',
  emptyAgent: 'Nothing here yet. Files your agent makes appear here.',
  loading: 'Loading files…',
  copyPath: 'Copy path',
  pathCopied: 'Path copied',
  filter: 'Filter this folder',
  clearFilter: 'Clear filter',
  preview: 'Preview',
  download: 'Download',
  moreActions: 'More actions',
  waking: 'Waking your cloud…',
  wakingNote: 'This takes about a minute',
} as const;

/** "No files match ‘menu’.", the filter shown as typed. */
export function noMatchWords(filter: string): string {
  return `No files match ‘${filter.trim()}’.`;
}

/** While more of the folder isn't loaded, the filter says it only looked at what is. */
export function partialFilterWords(loaded: number): string {
  return `Filtering the first ${loaded} loaded. Show more to include the rest.`;
}

/** How long "Path copied" shows before the button comes back. */
export const COPIED_MS = 2000;

/** A row's icon in its kind's soft colour, from the name only. */
export function FileKindIcon({
  entry,
  open = false,
  className,
}: {
  entry: Pick<CloudFileEntry, 'name' | 'kind'>;
  open?: boolean;
  className?: string;
}) {
  const kind = fileKind(entry);
  const look = FILE_KIND_LOOK[kind];
  const Icon = kind === 'folder' && open ? FolderOpen : look.icon;
  return (
    <Icon
      className={cn('size-4 shrink-0', look.className, className)}
      data-file-kind={kind}
      aria-hidden
    />
  );
}

/** A row's name for a screen reader, with its kind after it: "README.md, Markdown file". */
export function spokenName(
  entry: Pick<CloudFileEntry, 'name' | 'kind'>,
  title: string,
  large = false
): string {
  return `${title}, ${FILE_KIND_WORDS[fileKind(entry)]}${large ? ', large folder' : ''}`;
}

/** The pulse every placeholder shares: still at a steady 0.7 when motion is reduced. */
const PULSE = 'motion-safe:animate-pulse motion-reduce:opacity-70';

/** Grey rows the shape of the file list while a folder loads, in place of a spinner. */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label={EXPLORER_WORDS.loading}
      data-explorer-skeleton="list"
      className="p-3"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className={cn(
            'flex h-8 items-center gap-3 border-t border-border first:border-t-0',
            PULSE
          )}
        >
          <span className="size-4 shrink-0 rounded bg-background-3" />
          {/* Varied widths, so it reads as a list of names rather than a block. */}
          <span
            className="h-3 rounded bg-background-3"
            style={{ width: `${30 + ((index * 17) % 35)}%` }}
          />
          <span className="ml-auto h-3 w-12 rounded bg-background-3" />
          <span className="h-3 w-20 rounded bg-background-3" />
        </div>
      ))}
    </div>
  );
}

/** A few grey tree rows while a folder's children load. */
export function TreeSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul
      role="status"
      aria-label={EXPLORER_WORDS.loading}
      data-explorer-skeleton="tree"
      className="ml-3 flex flex-col gap-[1px]"
    >
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className={cn('flex h-7 items-center gap-1.5 pl-6', PULSE)}>
          <span className="size-3.5 shrink-0 rounded bg-background-3" />
          <span
            className="h-2.5 rounded bg-background-3"
            style={{ width: `${40 + index * 15}%` }}
          />
        </li>
      ))}
    </ul>
  );
}

/** The empty folder's words: an agent's own folder says files appear there as the agent makes them. */
export function EmptyFolder({ agentFolder }: { agentFolder: boolean }) {
  return (
    <p
      className="p-4 text-sm text-foreground-muted"
      data-explorer-empty={agentFolder ? 'agent' : 'folder'}
    >
      {agentFolder ? EXPLORER_WORDS.emptyAgent : EXPLORER_WORDS.empty}
    </p>
  );
}

/**
 * Copy path: puts the file's path within Your cloud files on the clipboard
 * (never a machine path), then shows a tick and "Path copied" for two seconds.
 */
export function CopyPathButton({
  path,
  size = 'sm',
  compact = false,
}: {
  path: string;
  size?: 'sm' | 'xs';
  /** Just the icon (named for screen readers), until it says "Path copied". */
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };
  return (
    <Button
      variant="ghost"
      size={size}
      onClick={() => void copy()}
      data-copy-path={path}
      aria-label={copied ? undefined : EXPLORER_WORDS.copyPath}
    >
      {copied ? (
        <Check className="size-3.5 text-foreground-success" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
      {/* At phone width the button is just its icon, until it says "Path copied". */}
      <span
        aria-live="polite"
        className={copied ? undefined : compact ? 'sr-only' : 'max-sm:sr-only'}
      >
        {copied ? EXPLORER_WORDS.pathCopied : EXPLORER_WORDS.copyPath}
      </span>
    </Button>
  );
}

/** No row matches the filter: say so, with a way to clear it. */
export function NoMatch({ filter, onClear }: { filter: string; onClear: () => void }) {
  return (
    <div
      className="flex items-center gap-2 p-4 text-sm text-foreground-muted"
      data-explorer-empty="filter"
    >
      <span>{noMatchWords(filter)}</span>
      <Button variant="outline" size="xs" onClick={onClear}>
        {EXPLORER_WORDS.clearFilter}
      </Button>
    </div>
  );
}

/**
 * A row's quick actions: Preview and Download for a file, Copy path for both.
 * With a mouse they show on the row's hover or focus. At phone width, or on a
 * touch screen, they sit in a "⋯" menu instead. Nothing here reads anything
 * until it's actually clicked.
 */
export function RowActions({
  path,
  isFile,
  label,
  onPreview,
  onDownload,
}: {
  /** The entry's path within Your cloud files. */
  path: string;
  isFile: boolean;
  /** The row's name, for the actions' accessible names. */
  label: string;
  onPreview: () => void;
  onDownload: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-0.5" data-row-actions="">
      <div className="hidden items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none sm:flex pointer-coarse:hidden">
        {isFile && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`${EXPLORER_WORDS.preview} ${label}`}
            onClick={onPreview}
          >
            <Eye className="size-3.5" aria-hidden />
          </Button>
        )}
        {isFile && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`${EXPLORER_WORDS.download} ${label}`}
            onClick={onDownload}
          >
            <Download className="size-3.5" aria-hidden />
          </Button>
        )}
        <CopyPathButton path={path} size="xs" compact />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex size-7 items-center justify-center rounded text-foreground-muted hover:bg-background-2 sm:hidden pointer-coarse:flex"
          aria-label={`${EXPLORER_WORDS.moreActions} for ${label}`}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isFile && (
            <DropdownMenuItem onClick={onPreview}>{EXPLORER_WORDS.preview}</DropdownMenuItem>
          )}
          {isFile && (
            <DropdownMenuItem onClick={onDownload}>{EXPLORER_WORDS.download}</DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => void copyWithToast(path)}>
            {EXPLORER_WORDS.copyPath}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Copy path from the "⋯" menu, which closes at once, so it says "Path copied" in a toast instead. */
async function copyWithToast(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
  } catch {
    return;
  }
  toast({ title: EXPLORER_WORDS.pathCopied });
}
