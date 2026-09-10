import type { Attachment, SessionChatClient } from '@switch-console/shared/session-v1';
import { useRef, useState } from 'react';
import { Button } from '@renderer/lib/ui/button';

type Entry = {
  id: string;
  file: File;
  attachment: Attachment | null;
  error: string | null;
  uploading: boolean;
};
function encodedFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read attachment.'));
    reader.readAsDataURL(file);
  });
}

export function useSessionAttachments(client: SessionChatClient, mimeTypes: string[]) {
  const current = useRef<Entry[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const update = (values: Entry[]) => {
    current.current = values;
    setEntries(values);
  };
  const upload = async (entry: Entry) => {
    update(
      current.current.map((value) =>
        value.id === entry.id ? { ...value, uploading: true, error: null } : value
      )
    );
    try {
      const mimeType = mimeTypes.includes(entry.file.type)
        ? entry.file.type
        : 'application/octet-stream';
      if (!mimeTypes.includes(mimeType)) throw new Error('This file type is not supported.');
      const attachment = await client.uploadAttachment({
        attachmentId: entry.id,
        name: entry.file.name,
        mimeType,
        data: await encodedFile(entry.file),
      });
      update(
        current.current.map((value) =>
          value.id === entry.id ? { ...value, uploading: false, attachment } : value
        )
      );
    } catch (error) {
      update(
        current.current.map((value) =>
          value.id === entry.id ? { ...value, uploading: false, error: String(error) } : value
        )
      );
    }
  };
  return {
    entries,
    error,
    blocked: entries.some((entry) => !entry.attachment),
    attachments: entries.flatMap((entry) => (entry.attachment ? [entry.attachment] : [])),
    add(files: File[]) {
      setError(null);
      if (!mimeTypes.length) {
        setError('Attachments are unavailable for this session.');
        return;
      }
      if (current.current.length + files.length > 8) {
        setError('Use at most eight attachments.');
        return;
      }
      if (files.some((file) => file.size === 0 || file.size > 10 * 1024 * 1024)) {
        setError('Each attachment must contain 1 byte to 10 MiB.');
        return;
      }
      const added = files.map(
        (file): Entry => ({
          id: crypto.randomUUID(),
          file,
          attachment: null,
          error: null,
          uploading: true,
        })
      );
      update([...current.current, ...added]);
      for (const entry of added) void upload(entry);
    },
    retry: (entry: Entry) => void upload(entry),
    remove: (id: string) => update(current.current.filter((entry) => entry.id !== id)),
    clear: () => {
      update([]);
      setError(null);
    },
  };
}

export function SessionAttachmentList({
  uploads,
  disabled,
}: {
  uploads: ReturnType<typeof useSessionAttachments>;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 px-2 text-xs">
      {uploads.error && (
        <p role="alert" className="text-foreground-destructive">
          {uploads.error}
        </p>
      )}
      {uploads.entries.map((entry) => (
        <div key={entry.id} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">
            {entry.file.name} · {entry.uploading ? 'Uploading…' : (entry.error ?? 'Attached')}
          </span>
          {entry.error && (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => uploads.retry(entry)}
            >
              Retry upload
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => uploads.remove(entry.id)}
            aria-label={`Remove ${entry.file.name}`}
          >
            Remove
          </Button>
        </div>
      ))}
    </div>
  );
}
