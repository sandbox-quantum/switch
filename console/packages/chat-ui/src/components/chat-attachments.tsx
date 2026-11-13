import { Download, FileIcon, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ChatAttachment } from '../contracts/chats';
import { type ChatHost, useChatHost } from '../host';
import { failureText } from '../model/failures';
import { Button } from '../primitives/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../primitives/dialog';

/**
 * A room attachment's bytes, fetched through the chat's media route (which
 * checks membership and that the file belongs to the room) and kept for the
 * session as object URLs — dropped when the person loses the room or the
 * server's chats are reset.
 */
const media = new Map<string, Promise<string>>();
const mediaKey = (serverId: string, roomId: string, uri: string) =>
  JSON.stringify([serverId, roomId, uri]);

/** Forgets the files of rooms the person lost, or of a server whose chats were reset. */
export function dropMedia(match: (serverId: string, roomId: string) => boolean): void {
  for (const [key, url] of media) {
    const [serverId, roomId] = JSON.parse(key) as [string, string];
    if (!match(serverId, roomId)) continue;
    media.delete(key);
    void url.then((value) => URL.revokeObjectURL(value)).catch(() => {});
  }
}
function mediaUrl(host: ChatHost, serverId: string, roomId: string, uri: string): Promise<string> {
  const key = mediaKey(serverId, roomId, uri);
  let url = media.get(key);
  if (!url) {
    url = host.media(serverId, roomId, uri).then(({ mimeType, data }) => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    });
    url.catch(() => media.delete(key));
    media.set(key, url);
  }
  return url;
}

async function saveAttachment(
  host: ChatHost,
  serverId: string,
  roomId: string,
  attachment: ChatAttachment
): Promise<void> {
  try {
    const url = await mediaUrl(host, serverId, roomId, attachment.uri);
    const link = document.createElement('a');
    link.href = url;
    link.download = attachment.filename;
    link.click();
  } catch (caught) {
    host.toast({
      title: failureText(caught, 'Could not download the file.'),
      variant: 'destructive',
    });
  }
}

function DownloadButton({ filename, onClick }: { filename: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="icon-xs"
      aria-label={`Download ${filename}`}
      title={`Download ${filename}`}
      onClick={onClick}
    >
      <Download className="size-3" />
    </Button>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ChatImage({
  serverId,
  roomId,
  attachment,
}: {
  serverId: string;
  roomId: string;
  attachment: ChatAttachment;
}) {
  const host = useChatHost();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    mediaUrl(host, serverId, roomId, attachment.uri)
      .then((value) => !cancelled && setUrl(value))
      .catch(
        (caught: unknown) =>
          !cancelled && setError(failureText(caught, 'Could not load the image.'))
      );
    return () => {
      cancelled = true;
    };
  }, [host, serverId, roomId, attachment.uri]);
  if (error) return <p className="text-xs text-foreground-destructive">{error}</p>;
  if (!url)
    return (
      <span className="flex size-24 items-center justify-center rounded-lg bg-background-1">
        <Loader2 className="size-4 animate-spin text-foreground-muted" />
      </span>
    );
  const save = () => void saveAttachment(host, serverId, roomId, attachment);
  return (
    <span className="group/image relative inline-block max-w-full">
      <button
        type="button"
        aria-label={`Open ${attachment.filename}`}
        onClick={() => setOpen(true)}
        className="block max-w-full cursor-zoom-in rounded-lg"
      >
        <img
          src={url}
          alt={attachment.filename}
          className="max-h-72 max-w-full rounded-lg border border-border object-contain"
        />
      </button>
      <span className="absolute top-1 right-1 opacity-0 shadow-sm transition-opacity group-focus-within/image:opacity-100 group-hover/image:opacity-100">
        <DownloadButton filename={attachment.filename} onClick={save} />
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="inset-0 h-full max-h-none w-full max-w-none translate-x-0 translate-y-0 gap-2 rounded-none bg-black/85 p-4 ring-0 sm:max-w-none"
          onClick={(event) => {
            // The popup fills the window, so its empty area stands in for the backdrop.
            if (!(event.target as Element).closest('img, button')) setOpen(false);
          }}
        >
          <div className="flex shrink-0 items-center gap-2">
            <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium text-white">
              {attachment.filename}
            </DialogTitle>
            <DownloadButton filename={attachment.filename} onClick={save} />
            <DialogClose
              render={
                <Button type="button" variant="secondary" size="icon-xs" aria-label="Close" />
              }
            >
              <X className="size-3" />
            </DialogClose>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <img
              src={url}
              alt={attachment.filename}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        </DialogContent>
      </Dialog>
    </span>
  );
}

function ChatFileChip({
  serverId,
  roomId,
  attachment,
}: {
  serverId: string;
  roomId: string;
  attachment: ChatAttachment;
}) {
  const host = useChatHost();
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    await saveAttachment(host, serverId, roomId, attachment);
    setBusy(false);
  };
  return (
    <button
      type="button"
      onClick={() => void download()}
      className="flex max-w-xs items-center gap-2 rounded-lg border border-border bg-background-1 px-3 py-2 text-left text-xs hover:bg-background-2"
      title={`Download ${attachment.filename}`}
    >
      {busy ? (
        <Loader2 className="size-4 shrink-0 animate-spin" />
      ) : (
        <FileIcon className="size-4 shrink-0 text-foreground-muted" />
      )}
      <span className="min-w-0 truncate">{attachment.filename}</span>
      <span className="shrink-0 text-foreground-muted">{formatSize(attachment.size)}</span>
    </button>
  );
}

export function ChatAttachments({
  serverId,
  roomId,
  attachments,
}: {
  serverId: string;
  roomId: string;
  attachments: ChatAttachment[];
}) {
  if (!attachments.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((attachment) =>
        attachment.mimetype.startsWith('image/') ? (
          <ChatImage
            key={attachment.uri}
            serverId={serverId}
            roomId={roomId}
            attachment={attachment}
          />
        ) : (
          <ChatFileChip
            key={attachment.uri}
            serverId={serverId}
            roomId={roomId}
            attachment={attachment}
          />
        )
      )}
    </div>
  );
}
