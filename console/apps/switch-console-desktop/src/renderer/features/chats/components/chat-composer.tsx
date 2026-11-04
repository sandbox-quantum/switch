import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Minimize2, Plus, RotateCcw, RotateCw, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import { reportBuddyMessage } from '@renderer/features/switch-buddy/buddy-telemetry';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { isEditableTarget } from '@renderer/lib/hooks/use-arrow-key-navigation';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { rpc } from '@renderer/lib/ipc';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { Button } from '@renderer/lib/ui/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@renderer/lib/ui/popover';
import { cn } from '@renderer/utils/utils';
import { agentInitials } from '@shared/core/agents/agent-avatar';
import {
  type ChatAgent,
  type ChatCommand,
  type ChatMessage,
  chatAgentLabel,
  requestIdOfClientTxn,
} from '@shared/core/chats/chats';
import { snippetOf } from '../chat-threads';
import { commandQuery, filterCommands } from '../command-query';
import {
  agentTargets,
  composeMentions,
  editMentions,
  filterMentionAgents,
  filterMentionPeople,
  type MentionPerson,
  mentionPayload,
  mentionQuery,
  mentionSegments,
  type MentionToken,
  type RememberedMention,
  withoutGroupMentions,
  personTargets,
  shiftMentions,
  tokenToRemove,
} from '../mentions';
import { isInterruptAck } from '../stop-rows';
import type { AgentActivity, ControlRequest } from '../stores/chat-activity-store';
import { type ChatDraft, chatDraftKey, readChatDraft, writeChatDraft } from '../stores/chat-drafts';
import type { ChatFile, ChatTimeline } from '../stores/chat-timeline-store';
import { chatTitler } from '../stores/chats';
import {
  PromptInput,
  PromptInputAttachments,
  PromptInputButton,
  PromptInputSubmit,
  PromptInputTextarea,
} from '../ui/prompt-input';
import { MentionMark } from './mention-mark';

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

type Suggestion =
  | { kind: 'agent'; id: string; agent: ChatAgent }
  | { kind: 'person'; id: string; person: MentionPerson & { email: string | null } }
  | { kind: 'command'; id: string; command: ChatCommand };

/** Chats just created here, whose composer takes focus when it first shows. */
const focusOnOpen = new Set<string>();
/** A send of a draft made before a reload, which may have landed: its id, and the draft as sent. */
type PendingResend = {
  requestId: string;
  text: string;
  mentions: MentionToken[];
  threadRootId: string | null;
};

function pendingOf(draft: ChatDraft | null): PendingResend | null {
  return draft?.pendingRequestId
    ? {
        requestId: draft.pendingRequestId,
        text: draft.text,
        mentions: draft.mentions,
        threadRootId: draft.pendingThreadRootId,
      }
    : null;
}

/** Whether the draft is still exactly what was sent before the reload (text and mentions). */
function unchangedSince(
  resend: PendingResend | null,
  text: string,
  mentions: MentionToken[]
): resend is PendingResend {
  return (
    resend !== null &&
    resend.text === text &&
    JSON.stringify(resend.mentions) === JSON.stringify(mentions)
  );
}

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
  people,
  groupName,
  activity,
  replyTo,
  onClearReply,
  disabled,
}: {
  serverId: string;
  timeline: ChatTimeline;
  agents: ChatAgent[];
  /** The other people in the chat, who can be mentioned after its agents. */
  people: (MentionPerson & { email: string | null })[];
  /** The chat's name when it is a group, which is who a message goes to; null in a direct chat. */
  groupName: string | null;
  activity: AgentActivity | null;
  replyTo: ChatMessage | null;
  onClearReply: () => void;
  disabled: string | null;
}) {
  // Kept across reloads and restarts, per account, workspace and room.
  const draftKey = chatDraftKey({
    serverId,
    userId: switchServersStore.statusFor(serverId)?.user?.id ?? null,
    workspaceId: workspacesStore.idOnServerInScope(serverId),
    roomId: timeline.roomId,
  });
  // A draft whose send is still in flight here (the chat was reopened, or its room
  // just made) is that send, not text to offer again.
  const [initial] = useState(() => {
    const kept = readChatDraft(draftKey);
    const inFlight = timeline.pending.some((send) => send.requestId === kept?.pendingRequestId);
    return { kept: inFlight ? null : kept, sending: inFlight ? kept!.pendingRequestId : null };
  });
  const [draft, setDraft] = useState(initial.kept?.text ?? '');
  /** The mentions picked from the list, each with who it names, kept with the draft. */
  const [picked, setPicked] = useState<MentionToken[]>(initial.kept?.mentions ?? []);
  /** The send that emptied the composer: its text stays kept until the server has taken it. */
  const [sending, setSending] = useState<string | null>(initial.sending);
  /**
   * A send of the restored draft made before a reload, which may have landed:
   * read from storage only, and gone once that draft is sent again or edited away.
   */
  const [resend, setResend] = useState<PendingResend | null>(pendingOf(initial.kept));
  const sendState =
    sending === null
      ? null
      : (timeline.pending.find((send) => send.requestId === sending)?.state ?? 'sent');
  // Another account, workspace or room shows its own draft, or none: the one on
  // screen is never carried over. Only typing done before this room's account and
  // workspace were known is kept for them, when they have nothing of their own.
  const [readFrom, setReadFrom] = useState(draftKey);
  if (readFrom !== draftKey) {
    const startup =
      readFrom ===
      chatDraftKey({ serverId, userId: null, workspaceId: null, roomId: timeline.roomId });
    const kept = readChatDraft(draftKey);
    setReadFrom(draftKey);
    if (kept || !startup) {
      setDraft(kept?.text ?? '');
      setPicked(kept?.mentions ?? []);
      setSending(null);
      setResend(pendingOf(kept));
    }
  }
  // The send before the reload did land: its draft is done with.
  const landed =
    unchangedSince(resend, draft, picked) &&
    timeline.messages.some(
      (message) => requestIdOfClientTxn(message.clientTxn) === resend.requestId
    );
  if (landed) {
    setDraft('');
    setPicked([]);
    setResend(null);
  }
  useEffect(() => {
    if (readFrom !== draftKey) return;
    if (draft === '' && sendState !== null && sendState !== 'sent') return;
    writeChatDraft(draftKey, {
      text: draft,
      mentions: picked,
      pendingRequestId: unchangedSince(resend, draft, picked) ? resend.requestId : null,
      pendingThreadRootId: unchangedSince(resend, draft, picked) ? resend.threadRootId : null,
    });
  }, [draftKey, readFrom, draft, picked, sendState, resend]);
  /** A pick the next edit inserts, placed once that edit has moved the others. */
  const pendingPick = useRef<MentionToken | null>(null);
  /** Picked mentions an edit removed, so undo and redo can bring them back with who they named. */
  const removed = useRef<RememberedMention[]>([]);
  const edit = (next: string, inputType: string | null) => {
    const pick = pendingPick.current;
    pendingPick.current = null;
    const result = editMentions(
      draft,
      next,
      picked,
      removed.current,
      inputType === 'historyUndo' || inputType === 'historyRedo'
    );
    removed.current = result.remembered;
    setPicked([...result.mentions, ...(pick ? [pick] : [])]);
    setDraft(next);
  };
  const [files, setFiles] = useState<{ id: string; file: File }[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  /** Where the `@` of a suggestion list Esc closed sits, so it stays closed for that `@`. */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  // Text typed rather than picked reads as an agent first where a person shares its name.
  // A server without group chats takes one agent mention and no people.
  const groupChats = useFeatureFlags(serverId).group_chats;
  const mentionPeople = groupChats ? people : [];
  const targets = [...agentTargets(agents), ...personTargets(mentionPeople)];
  const allowed = (found: MentionToken[]) => (groupChats ? found : withoutGroupMentions(found));
  const tokens = allowed(composeMentions(draft, picked, targets));
  const agentNamed = tokens.some((token) => token.kind === 'agent');
  const mentionable =
    (agents.length > 0 && (groupChats || !agentNamed)) || mentionPeople.length > 0;
  // A `!` that starts the message offers the room's commands, as the server lists them.
  const typingCommand = commandQuery(draft, caret);
  const commands = useQuery({
    queryKey: ['chat-commands', serverId, timeline.roomId],
    queryFn: () => rpc.chats.commands(serverId, timeline.roomId),
    enabled: typingCommand !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const query = typingCommand ?? (mentionable ? mentionQuery(draft, caret) : null);
  const suggestions: Suggestion[] = typingCommand
    ? filterCommands(commands.data ?? [], typingCommand.query).map((command): Suggestion => ({
        kind: 'command',
        id: `command:${command.name}`,
        command,
      }))
    : query
      ? [
          ...filterMentionAgents(agents, query.query).map((agent): Suggestion => ({
            kind: 'agent',
            id: agent.id,
            agent,
          })),
          ...filterMentionPeople(mentionPeople, query.query).map((person): Suggestion => ({
            kind: 'person',
            id: `user:${person.userId}`,
            person,
          })),
        ]
      : [];
  const suggesting = query !== null && query.start !== dismissedAt && suggestions.length > 0;
  const activeIndex = Math.min(mentionIndex, suggestions.length - 1);
  const listId = `mentions-${timeline.roomId}`;
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
  const recipient = groupName ?? (agent ? chatAgentLabel(agent) : 'the agent');
  const stopActivity = activity?.runningTurn ? activity : null;

  const addFiles = (list: File[]) => {
    if (!list.length) return;
    setFiles((current) => [...current, ...list.map((file) => ({ id: crypto.randomUUID(), file }))]);
    input.current?.focus();
  };

  const pick = (choice: Suggestion) => {
    const textarea = input.current;
    if (!textarea || !query) return;
    if (choice.kind === 'command') {
      const typed = `!${choice.command.name} `;
      textarea.focus();
      textarea.setSelectionRange(0, caret);
      if (!document.execCommand('insertText', false, typed)) {
        edit(`${typed}${draft.slice(caret)}`, null);
        setCaret(typed.length);
      }
      setMentionIndex(0);
      return;
    }
    const name = choice.kind === 'agent' ? choice.agent.name : choice.person.name;
    pendingPick.current = {
      kind: choice.kind,
      id: choice.kind === 'agent' ? choice.agent.id : choice.person.userId,
      start: query.start,
      end: query.start + 1 + name.length,
    };
    textarea.focus();
    textarea.setSelectionRange(query.start, caret);
    // insertText keeps the native undo stack; a controlled-value write would wipe it.
    if (!document.execCommand('insertText', false, `@${name} `)) {
      edit(`${draft.slice(0, query.start)}@${name} ${draft.slice(caret)}`, null);
      setCaret(query.start + name.length + 2);
    }
    setMentionIndex(0);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (suggesting) {
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (step) {
        event.preventDefault();
        setMentionIndex((activeIndex + step + suggestions.length) % suggestions.length);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        pick(suggestions[activeIndex]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissedAt(query.start);
        return;
      }
    }
    const textarea = event.currentTarget;
    if (
      (event.key === 'Backspace' || event.key === 'Delete') &&
      textarea.selectionStart === textarea.selectionEnd &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      const token = tokenToRemove(tokens, textarea.selectionStart, event.key);
      // Select the mention and let the key delete the selection: one native, undoable edit.
      if (token) textarea.setSelectionRange(token.start, token.end);
    }
  };

  const send = () => {
    const body = draft.trim();
    if (disabled || (!body && !files.length)) return;
    reportBuddyMessage(
      agents,
      timeline.messages.filter((message) => message.sender.kind === 'human').length +
        timeline.pending.length
    );
    const sent = allowed(composeMentions(body, shiftMentions(draft, body, picked), targets));
    const threadRootId = replyTo?.messageId ?? null;
    const requestId = timeline.send({
      body,
      threadRootId,
      ...mentionPayload(sent, groupChats),
      files: files.map(({ file }) => chatFile(file)),
      // The restored draft of a send made before a reload, sent again exactly as it
      // was, goes under the same id, so it lands once; anything else is a new message.
      requestId:
        unchangedSince(resend, draft, picked) &&
        files.length === 0 &&
        resend.threadRootId === threadRootId
          ? resend.requestId
          : null,
    });
    // Kept under its request id until the server takes it: a reload meanwhile
    // finds out whether it landed rather than offering it to be sent twice.
    writeChatDraft(draftKey, {
      text: draft,
      mentions: picked,
      pendingRequestId: requestId,
      pendingThreadRootId: threadRootId,
    });
    setResend(null);
    setSending(requestId);
    void chatTitler.sent(serverId, timeline.roomId, body);
    setDraft('');
    setPicked([]);
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
            <div className="relative min-w-0 flex-1">
              {suggesting && (
                <div
                  id={listId}
                  role="listbox"
                  aria-label={typingCommand ? 'Room commands' : 'Mention an agent or person'}
                  className="absolute bottom-full left-0 z-50 mb-3 flex max-h-60 w-72 flex-col overflow-y-auto rounded-md border bg-background-quaternary p-1 text-sm shadow-sm"
                >
                  {suggestions.map((each, index) => (
                    <div
                      key={each.id}
                      id={`${listId}-${each.id}`}
                      role="option"
                      aria-selected={index === activeIndex}
                      className={cn(
                        'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5',
                        index === activeIndex && 'bg-background-2'
                      )}
                      onMouseEnter={() => setMentionIndex(index)}
                      // Keep focus (and the caret) in the textarea.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => pick(each)}
                    >
                      {each.kind === 'command' ? (
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">{each.command.usage}</span>
                          <span className="truncate text-xs text-foreground-muted">
                            {each.command.description}
                          </span>
                        </span>
                      ) : each.kind === 'agent' ? (
                        <>
                          <AgentAvatar
                            name={each.agent.name}
                            iconUrl={each.agent.iconUrl}
                            serverId={serverId}
                            size={20}
                          />
                          <span className="truncate">{chatAgentLabel(each.agent)}</span>
                          {each.agent.alias && (
                            <span className="truncate text-xs text-foreground-muted">
                              @{each.agent.alias}
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          <span
                            aria-hidden
                            className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--fill-2)] text-[9px] font-medium text-foreground"
                          >
                            {agentInitials(each.person.name)}
                          </span>
                          <span className="truncate">{each.person.name}</span>
                          {each.person.email && (
                            <span className="ml-auto truncate text-xs text-foreground-muted">
                              {each.person.email}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div
                ref={backdrop}
                aria-hidden
                className="pointer-events-none absolute inset-0 overflow-y-auto px-1 py-1.5 text-sm break-words whitespace-pre-wrap text-transparent"
              >
                {mentionSegments(draft, tokens).map((segment, index) =>
                  segment.token ? (
                    <MentionMark
                      key={index}
                      kind={segment.token.kind}
                      // People are never tinted: their badge stays grey.
                      agent={
                        segment.token.kind === 'agent'
                          ? (agents.find((each) => each.id === segment.token?.id) ?? null)
                          : null
                      }
                      serverId={serverId}
                      className="text-transparent"
                    >
                      {segment.text}
                    </MentionMark>
                  ) : (
                    <span key={index}>{segment.text}</span>
                  )
                )}
                {/* A trailing newline only takes a line once something follows it. */}
                {'\u200b'}
              </div>
              <PromptInputTextarea
                ref={input}
                className="relative block min-h-0 px-1 py-1.5"
                aria-label={`Message ${recipient}`}
                placeholder={disabled ?? `Message ${recipient}...`}
                value={draft}
                disabled={disabled !== null}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={suggesting}
                aria-controls={suggesting ? listId : undefined}
                aria-activedescendant={
                  suggesting ? `${listId}-${suggestions[activeIndex]!.id}` : undefined
                }
                onKeyDown={onKeyDown}
                onChange={(event) => {
                  edit(event.target.value, (event.nativeEvent as InputEvent).inputType ?? null);
                  setCaret(event.target.selectionStart);
                  setMentionIndex(0);
                  if (
                    !mentionQuery(event.target.value, event.target.selectionStart) &&
                    !commandQuery(event.target.value, event.target.selectionStart)
                  )
                    setDismissedAt(null);
                }}
                onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
                onScroll={(event) => {
                  if (backdrop.current) backdrop.current.scrollTop = event.currentTarget.scrollTop;
                }}
              />
            </div>
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
