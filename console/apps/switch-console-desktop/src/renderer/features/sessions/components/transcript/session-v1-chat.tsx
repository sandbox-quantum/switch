import type { Command, SessionChatClient } from '@switch-console/shared/session-v1';
import { Check, Loader2, Paperclip, RotateCw, Square, Wrench } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { SessionHeaderContent } from '@renderer/features/sessions/session-header-slots';
import { Button } from '@renderer/lib/ui/button';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { Textarea } from '@renderer/lib/ui/textarea';
import type { InitialPromptDelivery } from '@shared/core/sessions/session-config';
import { SessionAttachmentList, useSessionAttachments } from './session-attachments';
import { sessionStatePill } from './session-state';
import { SessionStatePill } from './session-state-pill';
import { SessionV1Controls } from './session-v1-controls';
import { SessionV1Request } from './session-v1-request';

/** Both remote and local-only transports feed the same contract-shaped view. */
export function SessionV1Chat({
  client,
  restartHost,
  stopHost,
  startup,
  retireHost,
  initialPromptDelivery,
}: {
  client: SessionChatClient;
  initialPromptDelivery?: InitialPromptDelivery;
  restartHost?: () => Promise<void>;
  stopHost?: () => Promise<void>;
  startup?: { status: 'starting' | 'ready' | 'error'; message: string | null } | null;
  retireHost?: (epoch: string) => Promise<void>;
}) {
  const view = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const transcript = useRef<HTMLDivElement>(null);
  const transcriptContent = useRef<HTMLDivElement>(null);
  const followingBottom = useRef(true);
  useLayoutEffect(() => {
    const viewport = transcript.current;
    const content = transcriptContent.current;
    if (!viewport || !content) return;
    followingBottom.current = true;
    const follow = () => {
      if (followingBottom.current) viewport.scrollTop = viewport.scrollHeight;
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [client]);
  const [action, setAction] = useState<'restart' | 'resume' | 'stop' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const actionLock = useRef(false);
  const busy = action !== null || startup?.status === 'starting';
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    if (!completed) return;
    const timer = setTimeout(() => setCompleted(null), 5000);
    return () => clearTimeout(timer);
  }, [completed]);
  const runAction = async (kind: 'restart' | 'resume' | 'stop', run: () => Promise<void>) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setAction(kind);
    setActionError(null);
    setCompleted(null);
    setRetireConfirm(false);
    try {
      await run();
      await client.connect();
      setCompleted(
        kind === 'stop'
          ? 'Session stopped. Your conversation is saved.'
          : 'Session connected. You can continue your conversation.'
      );
    } catch (error) {
      setActionError(
        `${kind === 'stop' ? 'Stop was not confirmed' : 'Could not reconnect the session'}: ${String(error)}`
      );
    } finally {
      actionLock.current = false;
      setAction(null);
    }
  };
  const [draft, setDraft] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [retireConfirm, setRetireConfirm] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  useEffect(() => {
    void client.connect();
    return () => client.dispose();
  }, [client]);
  const session = view.snapshot?.session;
  const uploads = useSessionAttachments(client, session?.capabilities.attachmentMimeTypes ?? []);
  const picker = useRef<HTMLInputElement>(null);
  const available =
    !busy &&
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
  const noticesAfter = (itemId: string | null) =>
    view.notices
      .filter((notice) => notice.afterItemId === itemId)
      .map((notice, index) => (
        <p
          role="status"
          key={`${notice.code}-${index}`}
          className="text-sm text-foreground-warning"
        >
          {notice.message}
        </p>
      ));
  const waitingTurn = view.snapshot?.turns.find(
    (turn) =>
      (turn.status === 'queued' || turn.status === 'running') &&
      !view.snapshot?.items.some(
        (item) => item.turnId === turn.turnId && item.kind !== 'user-message'
      )
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
      <SessionHeaderContent slot="left">
        <SessionStatePill
          {...sessionStatePill({
            action: busy ? (action ?? 'start') : null,
            elapsedSeconds: elapsed,
            failed: Boolean(actionError) || startup?.status === 'error',
            retired: Boolean(session?.retired),
            status: session?.status ?? null,
            connectivity: session?.connectivity ?? null,
            reachable: available || (view.connected && session?.connectivity === 'online'),
          })}
        />
      </SessionHeaderContent>
      <SessionHeaderContent slot="right">
        {restartHost && !session?.retired && (
          <Button
            size="sm"
            variant="outline"
            disabled={
              busy ||
              !session ||
              sending ||
              client.hasPendingCommand() ||
              Boolean(runningTurn) ||
              Boolean(view.snapshot?.turns.some((turn) => turn.status === 'queued')) ||
              Boolean(session?.pendingRequestIds.length)
            }
            className={
              action === 'restart' || action === 'resume' ? 'disabled:opacity-100' : undefined
            }
            title={
              runningTurn || view.snapshot?.turns.some((turn) => turn.status === 'queued')
                ? 'Finish or interrupt the current work before restarting.'
                : session?.pendingRequestIds.length
                  ? 'Answer the pending request before restarting.'
                  : 'Reconnect the provider and keep this conversation.'
            }
            onClick={() =>
              void runAction(session?.status === 'stopped' ? 'resume' : 'restart', restartHost)
            }
          >
            {action === 'restart' || action === 'resume' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RotateCw className="size-3.5" />
            )}
            {action === 'restart'
              ? 'Restarting…'
              : action === 'resume'
                ? 'Resuming…'
                : session?.status === 'stopped'
                  ? 'Resume'
                  : 'Restart'}
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
        {session && !session.retired && session.status !== 'stopped' && (
          <Button
            size="sm"
            variant="outline"
            disabled={
              busy ||
              !view.connected ||
              session.connectivity !== 'online' ||
              sending ||
              client.hasPendingCommand()
            }
            className={action === 'stop' ? 'disabled:opacity-100' : undefined}
            title="Stop the provider. The conversation stays available to resume."
            onClick={() =>
              stopHost ? void runAction('stop', stopHost) : void control({ type: 'session.stop' })
            }
          >
            {action === 'stop' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Square className="size-3.5" />
            )}
            {action === 'stop' ? 'Stopping…' : 'Stop'}
          </Button>
        )}
      </SessionHeaderContent>
      {(busy ||
        (session?.status === 'starting' &&
          session.connectivity === 'online' &&
          !actionError &&
          startup?.status !== 'error')) && (
        <div
          role="status"
          aria-live="polite"
          className="flex gap-3 border-b border-border bg-background-1 px-5 py-3 text-sm"
        >
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-foreground-muted" />
          <div className="space-y-1">
            <p className="font-medium">
              {action === 'stop'
                ? 'Stopping the session…'
                : startup?.status === 'starting'
                  ? (startup.message ?? 'Connecting to the provider…')
                  : action === 'restart'
                    ? 'Preparing to restart…'
                    : 'Connecting to the provider…'}
            </p>
            <p className="text-foreground-muted">
              {action === 'stop'
                ? 'Waiting for the host to confirm it has stopped. Your conversation will stay here.'
                : 'Your conversation and draft stay here. You can keep writing while the session reconnects.'}
            </p>
            {elapsed >= 10 && (
              <p className="text-foreground-muted">
                This is taking longer than usual.{' '}
                {action === 'stop'
                  ? 'Still waiting for confirmation from the host.'
                  : 'The host is still reconnecting; authentication and remote startup can take a little longer.'}
              </p>
            )}
          </div>
        </div>
      )}
      {!busy && completed && !actionError && startup?.status !== 'error' && (
        <p
          role="status"
          className="flex items-center gap-2 border-b border-border px-5 py-3 text-sm"
        >
          <Check className="size-4" />
          {completed}
        </p>
      )}
      {!busy && (actionError || startup?.status === 'error') && (
        <div
          role="alert"
          className="space-y-1 border-b border-border px-5 py-3 text-sm text-foreground-destructive"
        >
          <p>{actionError ?? startup?.message}</p>
          <p className="text-foreground-muted">
            Your conversation and draft are preserved. Check the connection or sign-in details
            above, then retry using the session controls.
          </p>
        </div>
      )}
      {!busy && session?.status === 'stopped' && !session.retired && (
        <p role="status" className="border-b border-border px-5 py-3 text-sm text-foreground-muted">
          This session is stopped. Resume to continue the saved conversation. Interrupted work will
          not be repeated.
        </p>
      )}
      {(initialPromptDelivery?.state === 'unknown' ||
        initialPromptDelivery?.state === 'rejected') && (
        <div
          role="alert"
          className="border-b border-border px-5 py-3 text-sm [overflow-wrap:anywhere] text-foreground-destructive"
        >
          <p>
            {initialPromptDelivery.state === 'unknown'
              ? 'Initial prompt delivery is unresolved.'
              : 'The initial prompt was rejected.'}
          </p>
          <p>
            {initialPromptDelivery.message ??
              initialPromptDelivery.reason ??
              initialPromptDelivery.code}
          </p>
          <p>
            It will not be sent again automatically. Review the conversation before sending a new
            message.
          </p>
        </div>
      )}
      {session?.status === 'error' && !session.retired && session.capabilities.reset && (
        <div role="alert" className="border-b border-border px-5 py-3 text-sm">
          <p>This session cannot continue its conversation.</p>
          <p>
            You can start a fresh conversation and retain this history. Earlier unknown actions
            remain unknown and will not be repeated automatically. Queued room messages will be
            delivered to the fresh conversation.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={
              !view.connected ||
              session.connectivity !== 'online' ||
              sending ||
              client.hasPendingCommand() ||
              Boolean(runningTurn) ||
              Boolean(view.snapshot?.turns.some((turn) => turn.status === 'queued')) ||
              Boolean(session.pendingRequestIds.length)
            }
            onClick={() => void control({ type: 'session.reset' })}
          >
            Start a fresh conversation
          </Button>
        </div>
      )}
      {session?.retired && (
        <div role="status" className="px-5 py-3 text-sm">
          This session was retired. Its history is retained; prior uncertain actions remain unknown.
          Start a separate session from the agent page.
        </div>
      )}
      {retireHost &&
        !busy &&
        session &&
        !session.retired &&
        session.connectivity === 'offline' &&
        session.status !== 'stopped' && (
          <details className="border-b border-border px-5 py-3 text-sm text-foreground-muted">
            <summary className="cursor-pointer">Session recovery options</summary>
            <p className="my-2">
              The host is offline. Try restarting to reconnect to this conversation. Retire it only
              if you no longer want to recover it.
            </p>
            {retireConfirm ? (
              <>
                Retire this session permanently? Recovery will be disabled. This does not confirm
                whether prior actions completed. Start a separate session only after reviewing their
                effects.
                <Button
                  variant="destructive"
                  disabled={sending}
                  onClick={() => {
                    setSending(true);
                    void retireHost(session.epoch)
                      .then(() => client.connect())
                      .catch((error: unknown) => setSendError(String(error)))
                      .finally(() => {
                        setSending(false);
                        setRetireConfirm(false);
                      });
                  }}
                >
                  Retire session permanently
                </Button>
                <Button variant="outline" onClick={() => setRetireConfirm(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setRetireConfirm(true)}>
                Retire session…
              </Button>
            )}
          </details>
        )}
      {!busy && (view.error || !view.connected) && (
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
      <div
        ref={transcript}
        className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
        onScroll={(event) => {
          const viewport = event.currentTarget;
          followingBottom.current =
            viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 24;
        }}
      >
        <div ref={transcriptContent} className="mx-auto flex max-w-3xl flex-col gap-5 px-5 py-6">
          {noticesAfter(null)}
          {view.snapshot?.items.map((item) => (
            <div key={item.itemId}>
              {item.kind === 'user-message' ? (
                <div className="flex flex-col items-end gap-1">
                  {item.origin?.surface && item.origin.surface !== 'console' && (
                    <span className="ml-auto hidden text-tiny text-foreground-passive xl:inline">
                      {item.origin.surface}
                    </span>
                  )}
                  <div className="max-w-[85%] rounded-2xl bg-background-1 px-4 py-3 text-sm leading-relaxed break-words whitespace-pre-wrap">
                    {item.text}
                  </div>
                </div>
              ) : item.kind === 'assistant-message' ? (
                <div className="text-sm leading-relaxed">
                  <MarkdownRenderer variant="compact" content={item.text} />
                  {item.status === 'in-progress' && !stoppedTurns.has(item.turnId) && (
                    <span
                      aria-label="Still writing"
                      className="inline-block h-3 w-1 animate-pulse bg-foreground-muted"
                    />
                  )}
                </div>
              ) : (
                <details className="rounded-lg border border-border px-3 py-2 text-xs">
                  <summary className="flex cursor-pointer items-center gap-2">
                    {item.status === 'in-progress' && !stoppedTurns.has(item.turnId) ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Wrench className="size-3" />
                    )}
                    <span className="min-w-0 flex-1 break-words">{item.title}</span>
                    <span>
                      {item.status === 'in-progress'
                        ? (stoppedTurns.get(item.turnId) ?? item.status)
                        : item.status}
                    </span>
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
              {lastItems.get(item.turnId) === item.itemId &&
                view.snapshot?.requests
                  .filter((request) => request.turnId === item.turnId)
                  .map((request) => (
                    <SessionV1Request
                      key={request.requestId}
                      request={request}
                      client={client}
                      connected={view.connected}
                    />
                  ))}
              {noticesAfter(item.itemId)}
            </div>
          ))}
          {view.snapshot?.commandStatuses
            .filter((command) => command.status === 'rejected' || command.status === 'unknown')
            .map((command) => (
              <p key={command.commandId} className="text-xs text-foreground-muted">
                {command.status === 'unknown' ? (
                  <>
                    {command.code === 'HOST_RESTARTED'
                      ? "Switch couldn't confirm an earlier action before the session restarted."
                      : command.code === 'SESSION_RETIRED'
                        ? "Switch couldn't confirm an earlier action before the session was retired."
                        : "Switch couldn't confirm whether an earlier action finished."}{' '}
                    It won't run that action again automatically.
                    {command.message &&
                      !['HOST_RESTARTED', 'SESSION_RETIRED'].includes(command.code ?? '') && (
                        <span className="block">{command.message}</span>
                      )}
                  </>
                ) : (
                  <>
                    Command {command.status}
                    {command.message ? `: ${command.message}` : ''}
                  </>
                )}
              </p>
            ))}
          {(waitingTurn || (sending && pendingId)) && (
            <p role="status" className="flex items-center gap-2 text-sm text-foreground-muted">
              <Loader2 className="size-3 animate-spin" />
              {sending && pendingId
                ? 'Sending message…'
                : waitingTurn?.status === 'queued'
                  ? 'Message queued…'
                  : 'Waiting for the agent…'}
            </p>
          )}
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
          <div className="flex items-end gap-2 px-1 pt-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
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
            </div>
            <Button
              size="sm"
              className="ml-auto shrink-0"
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
        <p className="mt-1.5 px-1 text-right text-tiny text-foreground-passive">
          Enter to send · Shift + Enter for a new line
        </p>
      </div>
    </div>
  );
}
