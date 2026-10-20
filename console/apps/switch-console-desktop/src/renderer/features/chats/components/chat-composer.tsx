import { ChevronDown, Minimize2, Plus, RotateCcw, RotateCw, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { reportBuddyMessage } from '@renderer/features/switch-buddy/buddy-telemetry';
import { isEditableTarget } from '@renderer/lib/hooks/use-arrow-key-navigation';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { Button } from '@renderer/lib/ui/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@renderer/lib/ui/popover';
import { type ChatAgent, type ChatMessage, chatAgentLabel } from '@shared/core/chats/chats';
import { snippetOf } from '../chat-threads';
import { isInterruptAck } from '../stop-rows';
import type { AgentActivity, ControlRequest } from '../stores/chat-activity-store';
import type { ChatFile, ChatTimeline } from '../stores/chat-timeline-store';
import { chatTitler } from '../stores/chats';
import {
  PromptInput,
  PromptInputAttachments,
  PromptInputButton,
  PromptInputSubmit,
  PromptInputTextarea,
} from '../ui/prompt-input';

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

function chatFile(file: File): ChatFile {
  return { name: file.name, type: file.type, size: file.size, read: () => toBase64(file) };
}

/** Drafts by chat, so a draft outlives navigating away. */
const drafts = new Map<string, string>();

/** Chats just created here, whose composer takes focus when it first shows. */
const focusOnOpen = new Set<string>();
/** Composers on screen by chat; a chat's stream event can open it before its create returns. */
const mountedFocus = new Map<string, () => void>();

export function focusComposerWhenOpened(roomId: string): void {
  const focus = mountedFocus.get(roomId);
  if (focus) focus();
  else focusOnOpen.add(roomId);
}

const CONTROL_LABEL: Record<ControlRequest['command'], string> = {
  interrupt: 'Stop',
  reset: 'Reset',
  compact: 'Compact',
};

/**
 * Where each Stop, Reset or Compact sent from here stands: being posted,
 * posted and waiting for the agent, or the agent's answer, which it threads
 * under the command in the room.
 */
const ControlStatus = observer(function ControlStatus({
  activity,
  timeline,
  who,
}: {
  activity: AgentActivity;
  timeline: ChatTimeline;
  who: string;
}) {
  return (
    <>
      {activity.controls.map((control) => {
        const label = CONTROL_LABEL[control.command];
        const reply = control.commandId
          ? timeline.messages.findLast((message) => message.threadRootId === control.commandId)
          : undefined;
        const failed = control.state === 'failed';
        const unknown = control.state === 'unknown';
        // The turn's "Stopped" row says a Stop worked; only its failures show here.
        if (
          control.command === 'interrupt' &&
          !failed &&
          !unknown &&
          (!reply || isInterruptAck(reply))
        )
          return null;
        return (
          <div
            key={control.requestId}
            role={failed || unknown ? 'alert' : 'status'}
            className={`mb-2 flex items-start gap-2 text-xs ${failed || unknown ? 'text-foreground-destructive' : 'text-foreground-muted'}`}
          >
            <span className="min-w-0 flex-1">
              {failed
                ? `${label} was not sent: ${control.error}`
                : unknown
                  ? `${label} outcome unknown: ${control.error} Retrying sends the same ${label}, never a second one.`
                  : control.state === 'sending'
                    ? `Sending ${label}…`
                    : reply
                      ? `${label}: ${snippetOf(reply)}`
                      : `${label} requested — waiting for ${who} to answer.`}
            </span>
            {unknown && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void activity.retryControl(control.requestId)}
              >
                <RotateCw className="size-3" /> Retry
              </Button>
            )}
            {control.state !== 'sending' && !unknown && (
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => activity.dismissControl(control.requestId)}
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        );
      })}
    </>
  );
});

/**
 * The chat's composer. Sending posts the message to the room and nothing
 * else: which session answers, and starting or waking it, is up to the
 * agent's host. Stop, Reset and Compact are posted to the room as commands
 * for the agent, which answers each in the room.
 */
export const ChatComposer = observer(function ChatComposer({
  serverId,
  timeline,
  agents,
  activity,
  replyTo,
  onClearReply,
  disabled,
}: {
  serverId: string;
  timeline: ChatTimeline;
  agents: ChatAgent[];
  activity: AgentActivity | null;
  replyTo: ChatMessage | null;
  onClearReply: () => void;
  disabled: string | null;
}) {
  const draftKey = `${serverId}\u0000${timeline.roomId}`;
  const [draft, setDraft] = useState(() => drafts.get(draftKey) ?? '');
  useEffect(() => {
    drafts.set(draftKey, draft);
  }, [draftKey, draft]);
  const [files, setFiles] = useState<{ id: string; file: File }[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const roomId = timeline.roomId;
    const focus = () => requestAnimationFrame(() => input.current?.focus());
    if (focusOnOpen.delete(roomId)) focus();
    mountedFocus.set(roomId, focus);
    return () => {
      if (mountedFocus.get(roomId) === focus) mountedFocus.delete(roomId);
    };
  }, [timeline.roomId]);
  // Typing anywhere else in the chat goes to the composer, as in Slack.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const textarea = input.current;
      const target = event.target;
      if (!textarea || textarea.disabled || event.defaultPrevented || event.isComposing) return;
      if (event.key.length !== 1 || event.key === ' ') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (modalStore.isOpen || isEditableTarget(target) || !textarea.checkVisibility()) return;
      const panel = textarea.closest('[data-chat-panel]');
      if (target !== document.body && !(target instanceof Node && panel?.contains(target))) return;
      if (panel?.closest('[aria-hidden="true"]')) return;
      // Focus moved during keydown: the browser types the key into the textarea.
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
  const agent = agents[0] ?? null;
  const stopActivity = activity?.runningTurn ? activity : null;

  const addFiles = (list: File[]) => {
    if (!list.length) return;
    setFiles((current) => [...current, ...list.map((file) => ({ id: crypto.randomUUID(), file }))]);
    input.current?.focus();
  };

  const send = () => {
    const body = draft.trim();
    if (disabled || (!body && !files.length)) return;
    reportBuddyMessage(
      agents,
      timeline.messages.filter((message) => message.sender.kind === 'human').length +
        timeline.pending.length
    );
    timeline.send({
      body,
      threadRootId: replyTo?.messageId ?? null,
      files: files.map(({ file }) => chatFile(file)),
    });
    void chatTitler.sent(serverId, timeline.roomId, body);
    setDraft('');
    setFiles([]);
    onClearReply();
  };

  const showStop = Boolean(stopActivity) && !draft.trim() && !files.length;
  const stopping = stopActivity?.pendingControl?.command === 'interrupt';
  const status = stopping ? 'sending' : showStop ? 'running' : 'idle';
  // Not blocked while working: a turn whose host died stays running in the feed, and Reset is the way out.
  const contextBlocked = activity?.pendingControl
    ? 'Waiting for the previous command to be sent.'
    : null;

  return (
    <div className="mx-auto w-full max-w-[860px] px-5 pb-1.5">
      {activity && (
        <ControlStatus
          activity={activity}
          timeline={timeline}
          who={agent ? chatAgentLabel(agent) : 'the agent'}
        />
      )}
      {replyTo && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs text-foreground-muted">
          <span className="min-w-0 flex-1 truncate">
            Replying to {replyTo.sender.name}: {snippetOf(replyTo)}
          </span>
          <button type="button" aria-label="Cancel reply" onClick={onClearReply}>
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <div
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          addFiles(Array.from(event.dataTransfer.files));
        }}
        onPaste={(event) => {
          if (!event.clipboardData.files.length) return;
          event.preventDefault();
          addFiles(Array.from(event.clipboardData.files));
        }}
      >
        <PromptInput
          onSubmit={send}
          className="rounded-[20px] border-(--composer-border) bg-background-1/50 shadow-(--composer-shadow) duration-200 focus-within:border-(--composer-border-focus)"
        >
          <PromptInputAttachments
            items={files.map(({ id, file }) => ({ id, name: file.name, mediaType: file.type }))}
            onRemove={(id) => setFiles((current) => current.filter((each) => each.id !== id))}
          />
          <div className="flex items-end gap-1 p-2">
            <PromptInputButton
              tooltip="Attach files"
              className="size-8 rounded-full"
              disabled={disabled !== null}
              onClick={() => picker.current?.click()}
            >
              <Plus className="size-4" />
            </PromptInputButton>
            <input
              ref={picker}
              type="file"
              multiple
              className="hidden"
              aria-label="Choose attachments"
              onChange={(event) => {
                addFiles(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
            />
            <PromptInputTextarea
              ref={input}
              className="min-h-0 px-1 py-1.5"
              aria-label={`Message ${agent ? chatAgentLabel(agent) : 'the agent'}`}
              placeholder={disabled ?? `Message ${agent ? chatAgentLabel(agent) : 'the agent'}...`}
              value={draft}
              disabled={disabled !== null}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
            />
            <PromptInputSubmit
              status={status}
              className="h-8 min-w-8"
              onStop={() => void stopActivity?.control('interrupt')}
              stopDisabledReason={stopActivity?.pendingControl ? 'Sending…' : null}
              disabled={disabled !== null || (!showStop && !draft.trim() && !files.length)}
            />
          </div>
        </PromptInput>
        <div className="mt-1.5 flex min-h-7 items-center justify-end gap-1 px-2">
          {activity && (
            <Popover
              open={contextOpen}
              onOpenChange={(open) => {
                setContextOpen(open);
                setConfirmReset(false);
              }}
            >
              <PopoverTrigger
                render={<Button variant="ghost" size="sm" />}
                className="h-7 gap-1.5 rounded-md px-2 text-xs font-normal text-foreground-muted"
                aria-label="Context actions"
              >
                Context
                <ChevronDown className="size-3" />
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="end"
                className="w-80 max-w-[calc(100vw-2rem)] gap-2 p-3"
              >
                <PopoverTitle>
                  {confirmReset ? 'Start a fresh conversation?' : 'Conversation context'}
                </PopoverTitle>
                {confirmReset ? (
                  <>
                    <p className="text-xs text-foreground-muted">
                      The agent starts with a fresh context. Earlier messages stay in the transcript
                      as history.
                    </p>
                    <div className="flex justify-end gap-2 pt-2">
                      <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        disabled={contextBlocked !== null}
                        onClick={() => {
                          setContextOpen(false);
                          setConfirmReset(false);
                          void activity.control('reset');
                        }}
                      >
                        Start fresh
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      disabled={contextBlocked !== null}
                      className="h-auto justify-start gap-3 px-2 py-2 text-left"
                      onClick={() => {
                        setContextOpen(false);
                        void activity.control('compact');
                      }}
                    >
                      <Minimize2 className="size-4 shrink-0" />
                      <span>
                        <span className="block">Compact context</span>
                        <span className="block text-xs font-normal text-foreground-muted">
                          Free up space in this conversation
                        </span>
                      </span>
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={contextBlocked !== null}
                      className="h-auto justify-start gap-3 px-2 py-2 text-left"
                      onClick={() => setConfirmReset(true)}
                    >
                      <RotateCcw className="size-4 shrink-0" />
                      <span>
                        <span className="block">Reset context...</span>
                        <span className="block text-xs font-normal text-foreground-muted">
                          Start fresh and keep transcript history
                        </span>
                      </span>
                    </Button>
                    {contextBlocked && (
                      <p className="text-xs text-foreground-muted">{contextBlocked}</p>
                    )}
                    <p className="border-t border-border pt-2 text-xs text-foreground-muted">
                      Skills and MCP load from the execution host. Restart the host while idle after
                      changing their configuration.
                    </p>
                  </>
                )}
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>
    </div>
  );
});
