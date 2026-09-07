import type { SessionChatClient } from '@switch-console/shared/session-v1';
import { Loader2, Wrench } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { Textarea } from '@renderer/lib/ui/textarea';

/** Both remote and local-only transports feed the same contract-shaped view. */
export function SessionV1Chat({ client }: { client: SessionChatClient }) {
  const view = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [draft, setDraft] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  useEffect(() => {
    void client.connect();
    return () => client.dispose();
  }, [client]);
  const session = view.snapshot?.session;
  const available =
    view.connected &&
    session?.connectivity === 'online' &&
    (session.status === 'ready' || session.status === 'running');
  const send = async () => {
    if (!available || sending || !draft.trim()) return;
    const commandId = pendingId ?? crypto.randomUUID();
    setPendingId(commandId);
    setSending(true);
    setSendError(null);
    try {
      await client.send(draft.trim(), commandId);
      setDraft('');
      setPendingId(null);
    } catch (error) {
      setSendError(String(error));
      if (!client.hasPendingCommand()) setPendingId(null);
    } finally {
      setSending(false);
    }
  };
  const reconcile = async () => {
    setSending(true);
    try {
      await client.reconcile();
      setDraft('');
      setPendingId(null);
      setSendError(null);
    } catch (error) {
      setSendError(String(error));
      if (!client.hasPendingCommand()) setPendingId(null);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex items-center justify-between border-b border-border px-5 py-3 text-xs">
        <span>
          {session?.provider ?? 'Session'} · {session?.status ?? 'Loading'}
        </span>
        <span>
          {available || (view.connected && session?.connectivity === 'online')
            ? 'Connected'
            : 'Offline'}
        </span>
      </div>
      {(view.error || !view.connected) && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 bg-background-1 px-5 py-2 text-sm"
        >
          <span>{view.error ?? 'Connecting…'}</span>
          <Button size="sm" variant="outline" onClick={() => void client.connect()}>
            Reconnect
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-5 py-6">
          {view.snapshot?.items.map((item) => (
            <div key={item.itemId}>
              {item.kind === 'user-message' ? (
                <div className="flex flex-col items-end gap-1">
                  <span className="text-tiny text-foreground-passive">{item.origin?.surface}</span>
                  <div className="max-w-[85%] rounded-2xl bg-background-1 px-4 py-3 text-sm leading-relaxed break-words whitespace-pre-wrap">
                    {item.text}
                  </div>
                </div>
              ) : item.kind === 'assistant-message' ? (
                <div className="text-sm leading-relaxed">
                  <MarkdownRenderer variant="compact" content={item.text} />
                  {item.status === 'in-progress' && (
                    <span
                      aria-label="Still writing"
                      className="inline-block h-3 w-1 animate-pulse bg-foreground-muted"
                    />
                  )}
                </div>
              ) : (
                <details className="rounded-lg border border-border px-3 py-2 text-xs">
                  <summary className="flex cursor-pointer items-center gap-2">
                    {item.status === 'in-progress' ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Wrench className="size-3" />
                    )}
                    <span className="min-w-0 flex-1 break-words">{item.title}</span>
                    <span>{item.status}</span>
                  </summary>
                  {item.text && <p className="mt-2 whitespace-pre-wrap">{item.text}</p>}
                </details>
              )}
              {item.attachments.length > 0 && (
                <p className="mt-1 text-xs text-foreground-muted">
                  Attachments: {item.attachments.map((a) => a.name).join(', ')}
                </p>
              )}
            </div>
          ))}
          {view.notices.map((notice, index) => (
            <p
              role="status"
              key={`${notice.code}-${index}`}
              className="text-sm text-foreground-warning"
            >
              {notice.message}
            </p>
          ))}
          {view.snapshot?.commandStatuses.map((command) => (
            <p key={command.commandId} className="text-xs text-foreground-muted">
              Message {command.status}
              {command.message ? `: ${command.message}` : ''}
            </p>
          ))}
          {session?.pendingRequestIds.length ? (
            <p role="status" className="text-sm text-foreground-warning">
              This session has a pending request. Request controls are not available in this chat
              preview.
            </p>
          ) : null}
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl px-5 pb-5">
        {sendError && (
          <div role="alert" className="mb-2 text-sm text-foreground-destructive">
            {sendError}
            {pendingId && (
              <Button
                size="sm"
                variant="outline"
                disabled={sending}
                onClick={() => void reconcile()}
              >
                Check message status
              </Button>
            )}
          </div>
        )}
        <div className="rounded-xl border border-border bg-background-1 p-2">
          <Textarea
            aria-label="Message the agent"
            value={draft}
            readOnly={sending || pendingId !== null}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Message the agent…"
            className="min-h-16 border-0 bg-transparent shadow-none focus-visible:ring-0"
          />
          <div className="flex items-center justify-between px-1 pt-2">
            <span className="text-tiny text-foreground-passive">
              Enter to send · Shift + Enter for a new line
            </span>
            <Button
              size="sm"
              disabled={!available || sending || !draft.trim()}
              onClick={() => void send()}
            >
              {sending ? 'Sending…' : pendingId ? 'Retry message' : 'Send'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
