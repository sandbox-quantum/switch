import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { attachmentBlobType } from '@renderer/features/chats/components/attachment-blob-type';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@renderer/lib/ui/dialog';
import { Spinner } from '@renderer/lib/ui/spinner';
import {
  type CloudFileEntry,
  type CloudFilesCode,
  cloudFilesMessage,
  type NoPreviewReason,
} from '@shared/core/cloud-files/cloud-files';
import { Breadcrumb } from './cloud-files-breadcrumb';
import { formatChanged, formatChangedFull, formatSize } from './cloud-files-format';
import { FileText } from './file-markdown';
import { CodeView, CsvView, JsonView, MarkdownView, VideoView } from './preview-content';
import { neighbourFiles } from './preview-format';
import { WAKE_FAILED_MESSAGE, WAKE_GIVE_UP_MS, WAKE_RETRY_MS } from './use-cloud-files';

type Preview =
  | { kind: 'loading' }
  | { kind: 'image' | 'video'; url: string }
  | { kind: 'text' | 'markdown' | 'json'; text: string }
  | { kind: 'csv'; text: string; delimiter: ',' | '\t' }
  | { kind: 'code'; text: string; language: string }
  | { kind: 'download'; reason: NoPreviewReason }
  /** The file was deleted while the list was open. */
  | { kind: 'gone' }
  /** The box went to rest; Wake it wakes it and reads the same file again. */
  | { kind: 'resting' }
  | { kind: 'waking' }
  | { kind: 'error'; code: CloudFilesCode }
  | { kind: 'wake_failed' };

/** While waking, these mean "not up yet": read again shortly. */
const NOT_UP_YET = new Set<CloudFilesCode>(['box_resting', 'files_elsewhere', 'unreachable']);

const VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);

/** A file's bytes from the main process (base64) into a Blob URL of exactly `type`. */
function blobUrl(data: string, type: string): string {
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type }));
}

/** Whether a key press came from something that uses the arrow keys itself. */
function keepsArrows(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('video, input, textarea, select, [contenteditable="true"]') !== null
  );
}

/**
 * One file in a modal over the explorer. Images, video, code, Markdown, JSON
 * and CSV are shown inside; anything else, or anything too big, offers
 * Download. Only the file shown is fetched: previous and next never prefetch.
 * Esc, the close button or the backdrop closes it, and focus goes back to the
 * last file shown in the list.
 */
export function FilePreviewModal({
  serverId,
  folder,
  entries,
  entry,
  rootEntries,
  onShow,
  onOpenFolder,
  onClose,
}: {
  serverId: string;
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
  const path = folder ? `${folder}/${entry.name}` : entry.name;
  const [preview, setPreview] = useState<Preview>({ kind: 'loading' });
  const [saving, setSaving] = useState(false);
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
      [...document.querySelectorAll<HTMLElement>('[data-cloud-file]')].find(
        (row) => row.dataset.cloudFile === entry.name
      ) ?? null;
  }, [entry.name]);

  useEffect(() => {
    let url: string | null = null;
    let current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setPreview(wakeUntil.current === null ? { kind: 'loading' } : { kind: 'waking' });
    void rpc.cloudFiles
      .preview({ serverId, path, name: entry.name, size: entry.size })
      .then((result) => {
        if (!current) return;
        if (!result.ok) {
          if (wakeUntil.current !== null && NOT_UP_YET.has(result.code)) {
            if (Date.now() < wakeUntil.current) {
              retry = setTimeout(() => setAttempt((n) => n + 1), WAKE_RETRY_MS);
              return;
            }
            wakeUntil.current = null;
            return setPreview({ kind: 'error', code: 'timeout' });
          }
          wakeUntil.current = null;
          if (result.code === 'not_found') return setPreview({ kind: 'gone' });
          if (result.code === 'box_resting') return setPreview({ kind: 'resting' });
          return setPreview({ kind: 'error', code: result.code });
        }
        wakeUntil.current = null;
        const value = result.value;
        if (value.kind === 'image') {
          url = blobUrl(value.data, attachmentBlobType(value.mimeType));
          setPreview({ kind: 'image', url });
        } else if (value.kind === 'video') {
          // Typed exactly as the main process checked it; anything else isn't played.
          if (!VIDEO_TYPES.has(value.mimeType))
            return setPreview({ kind: 'download', reason: 'type' });
          url = blobUrl(value.data, value.mimeType);
          setPreview({ kind: 'video', url });
        } else setPreview(value);
      });
    return () => {
      current = false;
      clearTimeout(retry);
      if (url) URL.revokeObjectURL(url);
    };
  }, [serverId, path, entry.name, entry.size, attempt]);

  const wake = async () => {
    setPreview({ kind: 'waking' });
    if (!woke.current) {
      woke.current = true;
      try {
        await rpc.switchServers.ensureCloudMachine(serverId);
      } catch {
        if (mounted.current) setPreview({ kind: 'wake_failed' });
        return;
      }
    }
    if (!mounted.current) return;
    wakeUntil.current = Date.now() + WAKE_GIVE_UP_MS;
    setAttempt((n) => n + 1);
  };

  const save = async () => {
    setSaving(true);
    try {
      const result = await rpc.cloudFiles.saveFile({ serverId, path, name: entry.name });
      if (!result.ok) toast({ title: cloudFilesMessage(result.code), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        finalFocus={returnTo}
        className="h-[90dvh] w-[90vw] max-w-[90vw] max-sm:h-dvh max-sm:max-h-dvh max-sm:w-screen max-sm:max-w-none max-sm:rounded-none sm:max-w-[90vw]"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          if (keepsArrows(event.target)) return;
          const target = event.key === 'ArrowLeft' ? previous : next;
          if (!target) return;
          event.preventDefault();
          onShow(target);
        }}
      >
        <DialogTitle className="sr-only">{entry.name}</DialogTitle>
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <Breadcrumb
              path={folder}
              rootEntries={rootEntries}
              onOpen={(target) => {
                onClose();
                onOpenFolder(target);
              }}
              fileName={entry.name}
            />
            <p className="text-xs text-foreground-muted">
              {formatSize(entry.size)} · changed{' '}
              <span title={formatChangedFull(entry.mtime)}>{formatChanged(entry.mtime)}</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous file"
              disabled={!previous}
              onClick={() => previous && onShow(previous)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next file"
              disabled={!next}
              onClick={() => next && onShow(next)}
            >
              <ChevronRight className="size-4" />
            </Button>
            {preview.kind !== 'gone' && (
              <Button size="sm" disabled={saving} onClick={() => void save()}>
                {saving ? <Spinner /> : <Download className="size-3.5" aria-hidden />}
                Download
              </Button>
            )}
            <DialogClose
              render={<Button variant="ghost" size="icon-sm" aria-label="Close preview" />}
            >
              <X className="size-4" />
            </DialogClose>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4" data-preview-body="">
          <PreviewBody preview={preview} name={entry.name} onWake={() => void wake()} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({
  preview,
  name,
  onWake,
}: {
  preview: Preview;
  name: string;
  onWake: () => void;
}) {
  switch (preview.kind) {
    case 'loading':
      return (
        <div className="flex items-center gap-2 text-sm text-foreground-muted">
          <Spinner /> Loading the preview…
        </div>
      );
    case 'image':
      return (
        <img
          src={preview.url}
          alt={name}
          className="mx-auto max-h-full max-w-full rounded-md border border-border object-contain"
        />
      );
    case 'video':
      return <VideoView url={preview.url} label={name} />;
    case 'code':
      return <CodeView text={preview.text} language={preview.language} />;
    case 'json':
      return <JsonView text={preview.text} />;
    case 'csv':
      return <CsvView text={preview.text} delimiter={preview.delimiter} />;
    case 'markdown':
      return <MarkdownView text={preview.text} />;
    case 'text':
      return <FileText text={preview.text} />;
    case 'download':
      return (
        <p className="text-sm text-foreground-muted">
          {preview.reason === 'too_large'
            ? 'This file is too large to preview. Download it to open it on your computer.'
            : 'This file can’t be previewed here. Download it to open it on your computer.'}
        </p>
      );
    case 'gone':
      return <p className="text-sm text-foreground-muted">This file isn’t there any more.</p>;
    case 'resting':
      return (
        <div className="flex flex-col items-start gap-2 text-sm">
          <p>Your cloud is resting.</p>
          <p className="text-foreground-muted">
            Wake it to see this file; it counts as awake time.
          </p>
          <Button size="sm" onClick={onWake}>
            Wake it
          </Button>
        </div>
      );
    case 'waking':
      return (
        <div className="flex items-center gap-2 text-sm text-foreground-muted">
          <Spinner /> Waking your cloud… This usually takes a minute or two.
        </div>
      );
    case 'wake_failed':
      return (
        <p role="alert" className="text-sm text-destructive">
          {WAKE_FAILED_MESSAGE}
        </p>
      );
    case 'error':
      return (
        <p role="alert" className="text-sm text-destructive">
          {cloudFilesMessage(preview.code)}
        </p>
      );
  }
}
