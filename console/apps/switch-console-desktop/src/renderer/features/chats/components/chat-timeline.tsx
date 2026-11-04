import { format, isToday, isYesterday } from 'date-fns';
import { CornerUpLeft, Loader2, RotateCw, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Fragment, type ReactNode } from 'react';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/utils/utils';
import { agentInitials } from '@shared/core/agents/agent-avatar';
import type { ChatAgent, ChatMessage } from '@shared/core/chats/chats';
import {
  chatAgentLabel,
  isSessionStartingNotice,
  liveSessionStartingNotices,
  turnEndNotice,
} from '@shared/core/chats/chats';
import { foldTurnEndNotices, placeTurns, type TurnActivity } from '../activity-join';
import { messageAnchorId, threadChip } from '../chat-threads';
import {
  agentTargets,
  type MentionPerson,
  mentionSegments,
  mentionTokens,
  personTargets,
  tokensFromSpans,
} from '../mentions';
import { hiddenStopRows } from '../stop-rows';
import type { AgentActivity } from '../stores/chat-activity-store';
import type { ChatTimeline, PendingSend } from '../stores/chat-timeline-store';
import { ChatMarkdown } from '../ui/chat-markdown';
import { FailedIcon, WorkLogRow } from '../ui/work-log';
import {
  AgentRow,
  ChatActivityBlock,
  ChatRequests,
  turnEndLabel,
  turnShown,
} from './chat-activity-block';
import { ChatAttachments } from './chat-attachments';
import { MentionMark } from './mention-mark';

/** Messages more than this far apart start a new dated group. */
const GROUP_GAP_MS = 30 * 60 * 1000;

function dayLabel(date: Date): string {
  const time = format(date, 'HH:mm');
  if (isToday(date)) return `Today ${time}`;
  if (isYesterday(date)) return `Yesterday ${time}`;
  return format(date, 'd MMM yyyy, HH:mm');
}

function Separator({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center gap-3 text-xs text-foreground-passive', className)}>
      <span className="h-px flex-1 bg-border" />
      {children}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function isBridged(message: ChatMessage): boolean {
  return message.source !== 'console' && message.source !== 'switch';
}

/** A person's initials disc: people have no picture in Switch. */
/** `body` with each `@name` or `@alias` of a chat agent drawn as a badge. */
function MentionText({
  message,
  agents,
  people,
  serverId,
}: {
  message: ChatMessage;
  agents: ChatAgent[];
  people: MentionPerson[];
  serverId: string;
}) {
  const body = message.body;
  // The server's stretches say whom each mention names; older messages are read from the text,
  // the people the message names first, so one sharing an agent's name reads as the person.
  const tokens = message.mentions.length
    ? tokensFromSpans(body, message.mentions)
    : mentionTokens(body, [
        ...personTargets(people.filter((person) => message.namedUserIds.includes(person.userId))),
        ...agentTargets(agents),
      ]);
  return mentionSegments(body, tokens).map((segment, index) =>
    segment.token ? (
      <MentionMark
        key={index}
        kind={segment.token.kind}
        // People are never tinted: their badge stays grey.
        agent={
          segment.token.kind === 'agent'
            ? (agents.find((agent) => agent.id === segment.token?.id) ?? null)
            : null
        }
        serverId={serverId}
        className="text-foreground"
      >
        {segment.text}
      </MentionMark>
    ) : (
      <Fragment key={index}>{segment.text}</Fragment>
    )
  );
}

function PersonAvatar({ name }: { name: string }) {
  return (
    <span
      className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--fill-2)] text-[11px] font-medium text-foreground"
      title={name}
      aria-hidden
    >
      {agentInitials(name)}
    </span>
  );
}

function scrollToMessage(messageId: string): void {
  document
    .getElementById(messageAnchorId(messageId))
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function ThreadChipButton({ chip }: { chip: NonNullable<ReturnType<typeof threadChip>> }) {
  return (
    <button
      type="button"
      onClick={() => scrollToMessage(chip.rootId)}
      disabled={chip.snippet === null}
      className="max-w-full truncate text-left text-xs text-foreground-muted hover:text-foreground disabled:cursor-default"
    >
      {chip.label}
    </button>
  );
}

function ReplyButton({ onReply }: { onReply: () => void }) {
  return (
    <button
      type="button"
      onClick={onReply}
      aria-label="Reply"
      title="Reply in thread"
      className="invisible flex size-6 shrink-0 items-center justify-center rounded-md text-foreground-muted group-hover/row:visible hover:bg-background-1 hover:text-foreground"
    >
      <CornerUpLeft className="size-3.5" />
    </button>
  );
}

type Props = {
  serverId: string;
  timeline: ChatTimeline;
  agents: ChatAgent[];
  /** The chat's people, to name the ones a message mentions. */
  people: MentionPerson[];
  activities: AgentActivity[];
  onReply: (message: ChatMessage) => void;
};

/**
 * The chat's messages in sequence order, each agent's activity under the
 * room message that started it, then the sends from here the room has not
 * echoed yet.
 */
export const ChatTimelineView = observer(function ChatTimelineView({
  serverId,
  timeline,
  agents,
  people,
  activities,
  onReply,
}: Props) {
  const turnsByMessage = new Map<string, { activity: AgentActivity; turn: TurnActivity }[]>();
  const blocksByAnchor = new Map<string, { activity: AgentActivity; turn: TurnActivity }[]>();
  /** Turn-end notices shown on their turn's status row, by message id → `agentId:turnId`. */
  const foldedNotices = new Map<string, string>();
  const boundTurns = new Map(activities.map((activity) => [activity, activity.turns()]));
  for (const [activity, bound] of boundTurns) {
    for (const [messageId, turn] of bound) {
      const list = turnsByMessage.get(messageId) ?? [];
      list.push({ activity, turn });
      turnsByMessage.set(messageId, list);
    }
    for (const [anchorId, turns] of placeTurns(timeline.messages, activity.agentId, bound))
      blocksByAnchor.set(anchorId, [
        ...(blocksByAnchor.get(anchorId) ?? []),
        ...turns.map((turn) => ({ activity, turn })),
      ]);
    for (const [noticeId, turnId] of foldTurnEndNotices(timeline.messages, activity.agentId, bound))
      foldedNotices.set(noticeId, `${activity.agentId}:${turnId}`);
  }
  const endReasons = new Map(
    timeline.messages.flatMap((message) => {
      const turnKey = foldedNotices.get(message.messageId);
      return turnKey ? [[turnKey, turnEndNotice(message)?.reason ?? null] as const] : [];
    })
  );
  const agentOf = (agentId: string | null) => agents.find((agent) => agent.id === agentId) ?? null;
  const find = (messageId: string) => timeline.byId(messageId);
  const turnAgents = new Map(
    [...turnsByMessage].map(([messageId, list]) => [
      messageId,
      new Set(list.map(({ activity }) => activity.agentId)),
    ])
  );
  const liveNotices = liveSessionStartingNotices(timeline.messages, turnAgents);
  const stopRows = hiddenStopRows(timeline.messages);
  // Open requests whose turn shows under no loaded message still need an answer.
  const shownRequests = new Set(
    [...blocksByAnchor.values()].flatMap((blocks) =>
      blocks.flatMap(({ turn }) => turn.requests.map((request) => request.requestId))
    )
  );
  let previous: Date | null = null;
  /** The agent whose block the last row belongs to; its next row shows no avatar or name. */
  let blockAgent: string | null = null;
  const startsBlock = (agentId: string | null) => {
    const head = agentId === null || agentId !== blockAgent;
    blockAgent = agentId;
    return head;
  };
  let isFirstElement = true;
  const spacing = (isNewBlock: boolean = true): string => {
    if (isFirstElement) {
      isFirstElement = false;
      return '';
    }
    return isNewBlock ? 'mt-5' : 'mt-1.5';
  };
  return (
    <div className="flex flex-col">
      {timeline.hasMore && (
        <div className={cn('flex justify-center [overflow-anchor:none]', spacing())}>
          <Button
            size="sm"
            variant="ghost"
            disabled={timeline.loading}
            onClick={() => void timeline.loadOlder()}
          >
            {timeline.loading ? 'Loading…' : 'Load earlier messages'}
          </Button>
        </div>
      )}
      {timeline.messages.map((message) => {
        const notice = isSessionStartingNotice(message);
        if (notice && !liveNotices.has(message.messageId)) return null;
        if (foldedNotices.has(message.messageId) || stopRows.has(message.messageId)) return null;
        const ended = turnEndNotice(message);
        const sentAt = new Date(message.sentAt);
        // The conversation's first message gets no separator above it; a later group does.
        const newGroup =
          previous === null
            ? timeline.hasMore
            : sentAt.getTime() - previous.getTime() > GROUP_GAP_MS;
        const separator = newGroup ? (
          <Separator className={spacing()}>{dayLabel(sentAt)}</Separator>
        ) : null;
        previous = sentAt;
        if (separator) blockAgent = null;
        const chip = threadChip(message, find);
        const turns = turnsByMessage.get(message.messageId) ?? [];
        const agent = agentOf(message.sender.agentId);
        const agentLabel = {
          name: agent ? chatAgentLabel(agent) : message.sender.name,
          iconUrl: agent?.iconUrl ?? null,
        };
        const agentRow = notice || ended !== null || message.sender.kind === 'agent';
        const head = startsBlock(agentRow ? message.sender.agentId : null);
        return (
          <Fragment key={message.messageId}>
            {separator}
            {notice ? (
              <AgentRow
                id={messageAnchorId(message.messageId)}
                className={spacing(head)}
                agent={agentLabel}
                serverId={serverId}
                head={head}
                role="status"
              >
                <WorkLogRow
                  icon={<Loader2 aria-hidden className="size-3.5 animate-spin" />}
                  label={
                    agents.length > 1
                      ? `${message.sender.name} is starting a session…`
                      : 'Starting a session…'
                  }
                  active
                />
              </AgentRow>
            ) : ended ? (
              <AgentRow
                id={messageAnchorId(message.messageId)}
                className={spacing(head)}
                agent={agentLabel}
                serverId={serverId}
                head={head}
                role="status"
              >
                <WorkLogRow
                  icon={<FailedIcon />}
                  label={turnEndLabel(
                    ended.outcome === 'interrupted'
                      ? 'Stopped'
                      : ended.outcome === 'failed'
                        ? 'The turn ended with an error'
                        : 'Finished without replying',
                    ended.reason
                  )}
                  title={ended.reason ?? undefined}
                  tone={ended.outcome === 'completed' ? 'passive' : 'failed'}
                />
              </AgentRow>
            ) : message.sender.kind === 'human' ? (
              <div
                id={messageAnchorId(message.messageId)}
                className={cn('group/row flex gap-3', spacing())}
              >
                <PersonAvatar name={message.sender.name} />
                <div className="flex max-w-[85%] min-w-0 flex-col items-start gap-1">
                  <span className="flex items-center gap-1.5 text-xs">
                    <span className="font-medium text-foreground-muted">{message.sender.name}</span>
                    {isBridged(message) && (
                      <span className="rounded bg-background-1 px-1.5 py-px text-[10px] text-foreground-passive">
                        {bridgePlatformLabel(message.source)}
                      </span>
                    )}
                  </span>
                  {chip && <ThreadChipButton chip={chip} />}
                  <div className="min-w-0 rounded-2xl bg-background-1 px-4 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap">
                    <MentionText
                      message={message}
                      agents={agents}
                      people={people}
                      serverId={serverId}
                    />
                  </div>
                  <ChatAttachments
                    serverId={serverId}
                    roomId={timeline.roomId}
                    attachments={message.attachments}
                  />
                  {turns.some(({ turn }) => turn.status === 'queued') && (
                    <span className="text-xs text-foreground-passive">queued</span>
                  )}
                </div>
                <ReplyButton onReply={() => onReply(message)} />
              </div>
            ) : message.sender.kind === 'agent' ? (
              <AgentRow
                id={messageAnchorId(message.messageId)}
                className={cn('group/row', spacing(head))}
                agent={agentLabel}
                serverId={serverId}
                head={head}
                trailing={<ReplyButton onReply={() => onReply(message)} />}
              >
                <div className="flex flex-col gap-1">
                  {chip && <ThreadChipButton chip={chip} />}
                  <div className="text-sm leading-relaxed">
                    <ChatMarkdown>{message.body}</ChatMarkdown>
                  </div>
                  <ChatAttachments
                    serverId={serverId}
                    roomId={timeline.roomId}
                    attachments={message.attachments}
                  />
                </div>
              </AgentRow>
            ) : (
              <p
                id={messageAnchorId(message.messageId)}
                className={cn('text-center text-xs text-foreground-muted', spacing())}
              >
                {message.body}
              </p>
            )}
            {(blocksByAnchor.get(message.messageId) ?? []).map(({ activity, turn }) => {
              const turnAgent = agentOf(activity.agentId);
              const head = turnShown(activity, turn) && startsBlock(activity.agentId);
              return (
                <ChatActivityBlock
                  serverId={serverId}
                  key={`${activity.agentId}:${turn.turnId}`}
                  activity={activity}
                  turn={turn}
                  endReason={endReasons.get(`${activity.agentId}:${turn.turnId}`) ?? null}
                  head={head}
                  agent={{
                    name: turnAgent ? chatAgentLabel(turnAgent) : activity.agentId,
                    iconUrl: turnAgent?.iconUrl ?? null,
                  }}
                  className={spacing(head)}
                />
              );
            })}
          </Fragment>
        );
      })}
      {activities.map((activity) => {
        const requests = [...activity.approvals.values()].filter(
          (request) => request.state === 'open' && !shownRequests.has(request.requestId)
        );
        if (!requests.length) return null;
        const agent = agentOf(activity.agentId);
        const head = startsBlock(activity.agentId);
        return (
          <AgentRow
            key={`requests:${activity.agentId}`}
            agent={{
              name: agent ? chatAgentLabel(agent) : activity.agentId,
              iconUrl: agent?.iconUrl ?? null,
            }}
            serverId={serverId}
            head={head}
            className={spacing(head)}
          >
            <ChatRequests activity={activity} requests={requests} />
          </AgentRow>
        );
      })}
      {timeline.pending.map((send) => (
        <PendingBubble
          key={send.requestId}
          timeline={timeline}
          send={send}
          find={find}
          className={spacing()}
        />
      ))}
    </div>
  );
});

const PendingBubble = observer(function PendingBubble({
  timeline,
  send,
  find,
  className,
}: {
  timeline: ChatTimeline;
  send: PendingSend;
  find: (messageId: string) => ChatMessage | undefined;
  className?: string;
}) {
  const chip = send.threadRootId
    ? threadChip({ threadRootId: send.threadRootId, messageId: send.requestId }, find)
    : null;
  return (
    <div
      className={cn('flex flex-col items-start gap-1 pl-10', className)}
      aria-busy={send.state === 'sending'}
    >
      {chip && <ThreadChipButton chip={chip} />}
      <div className="max-w-[85%] rounded-2xl bg-background-1 px-4 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap opacity-70">
        {send.body}
      </div>
      {send.files.length > 0 && (
        <ul className="flex flex-col items-start gap-0.5 text-xs">
          {send.files.map((file) => (
            <li
              key={file.id}
              className={
                file.state === 'refused' ? 'text-foreground-destructive' : 'text-foreground-muted'
              }
            >
              {file.file.name}
              {file.state === 'uploading' && ' · uploading…'}
              {file.state === 'refused' && ` · not attached: ${file.error}`}
            </li>
          ))}
        </ul>
      )}
      {send.state === 'sending' ? (
        <span className="flex items-center gap-1 text-xs text-foreground-passive">
          <Loader2 className="size-3 animate-spin" /> Sending…
        </span>
      ) : (
        <div role="alert" className="flex max-w-[85%] flex-col items-start gap-1 text-xs">
          <span className="text-foreground-destructive">
            {send.state === 'conflict'
              ? 'This request id was already used for a different message, so it was not sent. Discard it and send again.'
              : send.uncertain
                ? `Not confirmed: ${send.error ?? 'Switch did not answer.'} Retrying sends the same message, never a second copy.`
                : send.error}
          </span>
          <span className="flex gap-1">
            {send.state === 'failed' && (
              <Button size="sm" variant="ghost" onClick={() => timeline.retry(send.requestId)}>
                <RotateCw className="size-3" /> Retry
              </Button>
            )}
            {send.state === 'failed' &&
              !send.posted &&
              send.files.some((file) => file.state === 'refused') && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => timeline.dropRefusedFiles(send.requestId)}
                >
                  Send without them
                </Button>
              )}
            <Button size="sm" variant="ghost" onClick={() => timeline.discard(send.requestId)}>
              <X className="size-3" /> Discard
            </Button>
          </span>
        </div>
      )}
    </div>
  );
});
