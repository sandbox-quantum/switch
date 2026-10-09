import type { Command } from '@switch-console/shared/session-v1';
import { Cpu, Loader2, Paperclip, Users, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { heldStatusText } from '@renderer/features/sessions/components/transcript/held-message';
import { SessionV1Controls } from '@renderer/features/sessions/components/transcript/session-v1-controls';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { ACTIVITY_UNAVAILABLE_TEXT } from '@shared/core/chats/activity';
import { type ChatAgent, type ChatMessage, chatAgentLabel } from '@shared/core/chats/chats';
import { mentionAgentIdFor, ROOM_ONLY } from '../addressee';
import { snippetOf } from '../chat-threads';
import type { AgentActivity } from '../stores/chat-activity-store';
import type { ChatFile, ChatTimeline } from '../stores/chat-timeline-store';
import {
  PromptInput,
  PromptInputAttachments,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
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

/** Why Stop cannot be used on the running turn, or null when it can. */
function stopBlocker(activity: AgentActivity | null): string | null {
  if (!activity?.session) return null;
  if (!activity.session.capabilities.interrupt)
    return "This agent's provider cannot be interrupted from here.";
  if (!activity.view?.connected) return 'Reconnecting to the agent’s session…';
  if (activity.client?.hasPendingCommand())
    return 'Waiting for the previous command to be confirmed.';
  return null;
}

/**
 * The chat's composer. Sending posts the message to the room and nothing
 * else: which session answers, and starting or waking it, is up to the
 * agent's host. The model picker and Stop act on the selected agent's own
 * session, and are offered only as far as that session says they work.
 */
export const ChatComposer = observer(function ChatComposer({
  serverId,
  timeline,
  agents,
  activity,
  selectedAgentId,
  onSelectAgent,
  replyTo,
  onClearReply,
  disabled,
}: {
  serverId: string;
  timeline: ChatTimeline;
  agents: ChatAgent[];
  /** The selected agent's activity, or the chat's own agent's when room-only. */
  activity: AgentActivity | null;
  /** An agent id, `ROOM_ONLY`, or null for the chat's first agent. */
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
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
  const [controlError, setControlError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const roomOnly = agents.length > 1 && selectedAgentId === ROOM_ONLY;
  const selected = roomOnly
    ? null
    : (agents.find((agent) => agent.id === selectedAgentId) ?? agents[0] ?? null);
  const session = activity?.session ?? null;
  const runningTurn = activity?.runningTurn ?? null;
  const target = activity?.target ?? null;

  // A held message waits for the machine: released once the session is found.
  useEffect(() => {
    if (timeline.held && target?.kind === 'session') timeline.setHeld(false);
  }, [timeline, timeline.held, target]);

  const addFiles = (list: File[]) => {
    if (!list.length) return;
    setFiles((current) => [...current, ...list.map((file) => ({ id: crypto.randomUUID(), file }))]);
  };

  const send = () => {
    const body = draft.trim();
    if (disabled || (!body && !files.length)) return;
    timeline.send({
      body,
      threadRootId: replyTo?.messageId ?? null,
      mentionAgentId: mentionAgentIdFor(agents, selectedAgentId),
      files: files.map(({ file }) => chatFile(file)),
    });
    setDraft('');
    setFiles([]);
    onClearReply();
    if (
      target?.kind === 'unavailable' &&
      target.reason === 'machine-asleep' &&
      target.wakeAgentKey
    ) {
      timeline.setHeld(true);
      rpc.sdkHost.cloudWake(target.wakeAgentKey).catch((error: unknown) => {
        timeline.setHeld(false);
        setControlError(failureText(error, 'Could not wake the cloud machine.'));
      });
    }
  };

  const execute = async (body: Command['body']) => {
    if (!activity?.client) return;
    setControlError(null);
    try {
      await activity.client.execute(body, crypto.randomUUID());
    } catch (error) {
      setControlError(failureText(error, 'The agent’s session did not take the command.'));
    }
  };

  const stop = async () => {
    if (!runningTurn) return;
    setStopping(true);
    await execute({ type: 'turn.interrupt', turnId: runningTurn.turnId });
    setStopping(false);
  };

  const blocker = stopBlocker(activity);
  const showStop = Boolean(runningTurn) && !draft.trim() && !files.length;
  const status = stopping ? 'sending' : showStop ? 'running' : 'idle';
  const unknownCommands =
    activity?.view?.snapshot?.commandStatuses.filter((each) => each.status === 'unknown') ?? [];
  const modelUnavailable =
    target?.kind === 'unavailable'
      ? target.message
      : !session
        ? 'Connecting to the agent’s session…'
        : null;

  return (
    <div className="mx-auto w-full max-w-[860px] px-5 pb-5">
      {timeline.held && (
        <div role="status" className="mb-2 flex items-center gap-2 text-sm text-foreground-muted">
          <Loader2 className="size-3 shrink-0 animate-spin" />
          <span className="min-w-0 flex-1">
            {heldStatusText('machine')} Your message is in the chat and is answered once it is up.
          </span>
          <Button size="sm" variant="ghost" onClick={() => timeline.setHeld(false)}>
            Dismiss
          </Button>
        </div>
      )}
      {unknownCommands.length > 0 && (
        <p role="status" className="mb-2 text-xs text-foreground-muted">
          Not confirmed: Switch couldn’t confirm whether an earlier action finished. It won’t run
          that action again automatically.
        </p>
      )}
      {controlError && (
        <p role="alert" className="mb-2 text-sm text-foreground-destructive">
          {controlError}
        </p>
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
        <PromptInput onSubmit={send}>
          <PromptInputAttachments
            items={files.map(({ id, file }) => ({ id, name: file.name, mediaType: file.type }))}
            onRemove={(id) => setFiles((current) => current.filter((each) => each.id !== id))}
          />
          <PromptInputTextarea
            aria-label={`Message ${selected ? chatAgentLabel(selected) : 'the room'}`}
            placeholder={disabled ?? `Message ${selected ? chatAgentLabel(selected) : 'the room'}…`}
            value={draft}
            disabled={disabled !== null}
            onChange={(event) => setDraft(event.target.value)}
          />
          <PromptInputFooter>
            <PromptInputTools>
              {agents.length > 1 && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="ghost" size="sm" />}
                    className="h-7 gap-1.5 px-2 text-xs font-normal text-foreground-muted"
                    aria-label="Agent to address"
                  >
                    {selected ? (
                      <>
                        <AgentAvatar
                          name={chatAgentLabel(selected)}
                          iconUrl={selected.iconUrl}
                          size={14}
                        />
                        {chatAgentLabel(selected)}
                      </>
                    ) : (
                      <>
                        <Users className="size-3.5" />
                        Room only
                      </>
                    )}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuRadioGroup
                      value={selected?.id ?? ROOM_ONLY}
                      onValueChange={(value) => onSelectAgent(String(value))}
                    >
                      {agents.map((agent) => (
                        <DropdownMenuRadioItem key={agent.id} value={agent.id}>
                          {chatAgentLabel(agent)}
                        </DropdownMenuRadioItem>
                      ))}
                      <DropdownMenuRadioItem value={ROOM_ONLY}>
                        Room only (no agent)
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {session && activity?.client ? (
                <SessionV1Controls
                  key={`${session.epoch}:${JSON.stringify(session.model)}`}
                  session={session}
                  disabled={
                    !activity.view?.connected ||
                    session.connectivity !== 'online' ||
                    activity.client.hasPendingCommand() ||
                    session.status !== 'ready' ||
                    activity.working ||
                    session.pendingRequestIds.length > 0
                  }
                  execute={execute}
                />
              ) : (
                <PromptInputButton
                  disabled
                  tooltip={modelUnavailable ?? ACTIVITY_UNAVAILABLE_TEXT['not-on-this-machine']}
                >
                  <Cpu className="size-3.5" />
                </PromptInputButton>
              )}
              <PromptInputButton
                tooltip="Attach files"
                disabled={disabled !== null}
                onClick={() => picker.current?.click()}
              >
                <Paperclip className="size-3.5" />
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
            </PromptInputTools>
            <PromptInputSubmit
              status={status}
              onStop={() => void stop()}
              stopDisabledReason={blocker}
              disabled={disabled !== null || (!showStop && !draft.trim() && !files.length)}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
});
