import type { Command, SessionChatClient } from '@switch-console/shared/session-v1';
import { Loader2, Paperclip, Wrench } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { Textarea } from '@renderer/lib/ui/textarea';
import { SessionAttachmentList, useSessionAttachments } from './session-attachments';
import { SessionV1Controls } from './session-v1-controls';
import { SessionV1Request } from './session-v1-request';

/** Both remote and local-only transports feed the same contract-shaped view. */
export function SessionV1Chat({
  client,
  restartHost,
}: {
  client: SessionChatClient;
  restartHost?: () => Promise<void>;
}) {
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
  const uploads = useSessionAttachments(client, session?.capabilities.attachmentMimeTypes ?? []);
  const picker = useRef<HTMLInputElement>(null);
  const available =
    view.connected &&
    session?.connectivity === 'online' &&
    (session.status === 'ready' || session.status === 'running');
  const runningTurn = view.snapshot?.turns.find((turn) => turn.status === 'running');
  const lastItems = new Map(view.snapshot?.items.map((item) => [item.turnId, item.itemId]));
  const stoppedTurns = new Map(
    view.snapshot?.turns
      .filter((turn) => turn.status === 'interrupted' || turn.status === 'error')
      .map((turn) => [turn.turnId, turn.status])
  );
  const control = async (body: Command['body']) => {
    setSending(true);
    setSendError(null);
    try {
      await client.execute(body, crypto.randomUUID());
    } catch (error) {
      setSendError(String(error));
    } finally {
      setSending(false);
    }
  };
  const send = async () => {
    if (!available || sending || uploads.blocked || (!draft.trim() && !uploads.attachments.length))
      return;
    const commandId = pendingId ?? crypto.randomUUID();
    setPendingId(commandId);
    setSending(true);
    setSendError(null);
    try {
      await client.send(draft.trim(), commandId, uploads.attachments);
      uploads.clear();
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
      if (pendingId) {
        setDraft('');
        uploads.clear();
      }
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
        <div className="flex items-center gap-2">
          {restartHost && session?.status !== 'stopped' && (
            <Button
              size="sm"
              variant="outline"
              disabled={
                sending ||
                client.hasPendingCommand() ||
                Boolean(runningTurn) ||
                Boolean(view.snapshot?.turns.some((turn) => turn.status === 'queued')) ||
                Boolean(session?.pendingRequestIds.length)
              }
              onClick={() => {
                setSending(true);
                setSendError(null);
                void restartHost()
                  .then(() => client.connect())
                  .catch((error: unknown) => setSendError(String(error)))
                  .finally(() => setSending(false));
              }}
            >
              Restart host
            </Button>
          )}
          {runningTurn && session?.capabilities.interrupt && (
            <Button
              size="sm"
              variant="outline"
              disabled={!available || sending || client.hasPendingCommand()}
              onClick={() => void control({ type: 'turn.interrupt', turnId: runningTurn.turnId })}
            >
              Interrupt
            </Button>
          )}
          {session && session.status !== 'stopped' && (
            <Button
              size="sm"
              variant="outline"
              disabled={
                !view.connected ||
                session.connectivity !== 'online' ||
                sending ||
                client.hasPendingCommand()
              }
              onClick={() => void control({ type: 'session.stop' })}
            >
              Stop session
            </Button>
          )}
          <span>
            {available || (view.connected && session?.connectivity === 'online')
              ? 'Connected'
              : 'Offline'}
          </span>
        </div>
      </div>
      {session && !session.capabilities.questions && (
        <div className="px-5 py-2 text-xs text-foreground-muted">
          This provider does not support interactive questions. Supply additional instructions in
          chat.
        </div>
      )}
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
                  <span className="ml-auto hidden text-tiny text-foreground-passive xl:inline">
                    {item.origin?.surface}
                  </span>
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
              {lastItems.get(item.turnId) === item.itemId && stoppedTurns.has(item.turnId) && (
                <p role="status" className="mt-2 text-sm text-foreground-destructive">
                  Turn {stoppedTurns.get(item.turnId)}.
                </p>
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
          {view.snapshot?.commandStatuses
            .filter((command) => command.status !== 'applied')
            .map((command) => (
              <p key={command.commandId} className="text-xs text-foreground-muted">
                Command {command.status}
                {command.message ? `: ${command.message}` : ''}
              </p>
            ))}
          {view.snapshot?.requests.map((request) => (
            <SessionV1Request
              key={request.requestId}
              request={request}
              client={client}
              connected={view.connected}
            />
          ))}
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl px-5 pb-5">
        {sendError && (
          <div role="alert" className="mb-2 text-sm text-foreground-destructive">
            {sendError}
            {client.hasUnknownCommand() && (
              <Button
                size="sm"
                variant="outline"
                disabled={sending}
                onClick={() => {
                  setSending(true);
                  void client
                    .acknowledgeUnknown()
                    .then(() => {
                      setDraft('');
                      uploads.clear();
                      setPendingId(null);
                      setSendError(null);
                    })
                    .catch((error: unknown) => setSendError(String(error)))
                    .finally(() => setSending(false));
                }}
              >
                Acknowledge unknown outcome and clear draft
              </Button>
            )}
            {client.hasPendingCommand() && (
              <Button
                size="sm"
                variant="outline"
                disabled={sending}
                onClick={() => void reconcile()}
              >
                Check command status
              </Button>
            )}
          </div>
        )}
        <div
          className="rounded-xl border border-border bg-background-1 p-2"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) event.preventDefault();
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            if (!sending && !pendingId) uploads.add(Array.from(event.dataTransfer.files));
          }}
          onPaste={(event) => {
            if (!event.clipboardData.files.length) return;
            event.preventDefault();
            if (!sending && !pendingId) uploads.add(Array.from(event.clipboardData.files));
          }}
        >
          <SessionAttachmentList uploads={uploads} disabled={sending || pendingId !== null} />
          <input
            ref={picker}
            type="file"
            multiple
            className="hidden"
            aria-label="Choose attachments"
            onChange={(event) => {
              uploads.add(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
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
          <div className="flex flex-wrap items-center gap-1 px-1 pt-2">
            {session && (
              <SessionV1Controls
                key={`${session.epoch}:${JSON.stringify(session.model)}`}
                session={session}
                disabled={
                  !available ||
                  sending ||
                  client.hasPendingCommand() ||
                  session.status !== 'ready' ||
                  Boolean(
                    view.snapshot?.turns.some(
                      (turn) => turn.status === 'queued' || turn.status === 'running'
                    )
                  ) ||
                  session.pendingRequestIds.length > 0
                }
                execute={control}
              />
            )}

            {Boolean(session?.capabilities.attachmentMimeTypes.length) && (
              <Button
                size="sm"
                variant="ghost"
                disabled={sending || pendingId !== null}
                aria-label="Attach files"
                title="Attach files"
                onClick={() => picker.current?.click()}
              >
                <Paperclip className="size-3.5" />
              </Button>
            )}
            <span className="ml-auto hidden text-tiny text-foreground-passive xl:inline">
              Enter to send · Shift + Enter for a new line
            </span>
            <Button
              size="sm"
              className="ml-auto xl:ml-1"
              disabled={
                !available ||
                sending ||
                uploads.blocked ||
                (!draft.trim() && !uploads.attachments.length)
              }
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
