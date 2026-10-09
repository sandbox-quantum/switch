import { FileIcon, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { events } from '@renderer/lib/ipc';
import { chatRemovedChannel, chatResetChannel } from '@shared/core/chats/chatEvents';
import type { ChatAttachment } from '@shared/core/chats/chats';

/**
 * A room attachment's bytes, fetched through the chat's media route (which
 * checks membership and that the file belongs to the room) and kept for the
 * session as object URLs — dropped when the person loses the room or the
 * server's chats are reset.
 */
const media = new Map<string, Promise<string>>();
const mediaKey = (serverId: string, roomId: string, uri: string) =>
  JSON.stringify([serverId, roomId, uri]);

function dropMedia(match: (serverId: string, roomId: string) => boolean): void {
  for (const [key, url] of media) {
    const [serverId, roomId] = JSON.parse(key) as [string, string];
    if (!match(serverId, roomId)) continue;
    media.delete(key);
    void url.then((value) => URL.revokeObjectURL(value)).catch(() => {});
  }
}
events.on(chatRemovedChannel, ({ serverId, roomId, reason }) => {
  if (reason === 'access') dropMedia((s, r) => s === serverId && r === roomId);
});
events.on(chatResetChannel, ({ serverId }) => dropMedia((s) => s === serverId));

function mediaUrl(serverId: string, roomId: string, uri: string): Promise<string> {
  const key = mediaKey(serverId, roomId, uri);
  let url = media.get(key);
  if (!url) {
    url = rpc.chats.media({ serverId, roomId, uri }).then(({ mimeType, data }) => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    });
    url.catch(() => media.delete(key));
    media.set(key, url);
  }
  return url;
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
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    mediaUrl(serverId, roomId, attachment.uri)
      .then((value) => !cancelled && setUrl(value))
      .catch(
        (caught: unknown) =>
          !cancelled && setError(failureText(caught, 'Could not load the image.'))
      );
    return () => {
      cancelled = true;
    };
  }, [serverId, roomId, attachment.uri]);
  if (error) return <p className="text-xs text-foreground-destructive">{error}</p>;
  if (!url)
    return (
      <span className="flex size-24 items-center justify-center rounded-lg bg-background-1">
        <Loader2 className="size-4 animate-spin text-foreground-muted" />
      </span>
    );
  return (
    <img
      src={url}
      alt={attachment.filename}
      className="max-h-72 max-w-full rounded-lg border border-border object-contain"
    />
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
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const url = await mediaUrl(serverId, roomId, attachment.uri);
      const link = document.createElement('a');
      link.href = url;
      link.download = attachment.filename;
      link.click();
    } catch (caught) {
      toast({ title: failureText(caught, 'Could not download the file.'), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
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
