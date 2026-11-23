import { format, isToday, isYesterday } from 'date-fns';
import { CornerUpLeft, Loader2, RotateCw, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Fragment, type ReactNode, useState } from 'react';
import { isOwnBuddy } from '@renderer/features/switch-buddy/own-buddies';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/utils/utils';
import { agentInitials } from '@shared/core/agents/agent-avatar';
import { readsAsSwitchBuddy } from '@shared/core/agents/switch-buddy';
import type { ChatApproval } from '@shared/core/chats/activity';
import type { ChatAgent, ChatKickoff, ChatMessage } from '@shared/core/chats/chats';
import {
  chatAgentNaming,
  isSessionStartingNotice,
  liveSessionStartingNotices,
  turnEndNotice,
} from '@shared/core/chats/chats';
import { personColour } from '@shared/core/people/person-colour';
import {
  foldTurnEndNotices,
  placeRequests,
  placeTurns,
  splitTurn,
  type TurnActivity,
} from '../activity-join';
import { type ChatEntrance, Entrance } from '../chat-entrance';
import { messageAnchorId, threadChip } from '../chat-threads';
import {
  agentTargets,
  type MentionPerson,
  mentionSegments,
  mentionTokens,
  personTargets,
  tokensFromSpans,
} from '../mentions';
import { messageText } from '../message-text';
import { hiddenStopRows } from '../stop-rows';
import type { AgentActivity } from '../stores/chat-activity-store';
import type { ChatTimeline, PendingSend } from '../stores/chat-timeline-store';
import { ChatMarkdown } from '../ui/chat-markdown';
import { FailedIcon, WorkLogRow } from '../ui/work-log';
import {
  AgentRow,
  ChatActivityBlock,
  ChatRequests,
  type RowAgent,
  turnEndLabel,
  turnShown,
} from './chat-activity-block';
import { requestAsker } from './chat-approval-card';
import { ChatAttachments } from './chat-attachments';
import { MentionMark } from './mention-mark';

/**
 * An agent as a row names it (`chatAgentNaming`). One the chat does not list
 * goes by `fallback`, the name it sent under or its id; but a name that reads
 * as switch-buddy's, on an agent that is not the person's own buddy, cannot
 * be checked against a unique name, so it goes by its id.
 */
function rowAgent(
  agent: ChatAgent | null,
  agentId: string | null,
  fallback: string,
  serverId: string
): RowAgent {
  if (agent) {
    const { label, uniqueName } = chatAgentNaming(agent, isOwnBuddy(serverId, agent.id));
    return { id: agent.id, name: label, uniqueName, iconUrl: agent.iconUrl };
  }
  const unchecked =
    agentId !== null && readsAsSwitchBuddy(fallback) && !isOwnBuddy(serverId, agentId);
  return { id: null, name: unchecked ? agentId : fallback, uniqueName: null, iconUrl: null };
}

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
  const body = messageText(message);
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

function PersonAvatar({ name, userId }: { name: string; userId: string | null }) {
  return (
    <span
      className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-medium"
      style={personColour(userId ?? name)}
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
  /** Which first messages slide in, as the chat opens from a hand-off. */
  entrance: ChatEntrance;
};

/**
 * The chat's messages in sequence order, each agent's activity under the
 * room message that started it (under its latest reply while running), then
 * the sends from here the room has not echoed yet.
 */
export const ChatTimelineView = observer(function ChatTimelineView({
  serverId,
  timeline,
  agents,
  people,
  activities,
  onReply,
  entrance,
}: Props) {
  // Your first message is chosen as the chat is first drawn: the one waiting
  // to be sent then, or already sent. It does not slide in again when the
  // server takes a waiting one and it is drawn as sent.
  const [enteringOwnId] = useState(() =>
    entrance.firstOwn && !timeline.hasMore
      ? (timeline.messages.find((message) => message.sender.kind === 'human')?.messageId ??
        timeline.pending[0]?.requestId ??
        null)
      : null
  );
  const turnsByMessage = new Map<string, { activity: AgentActivity; turn: TurnActivity }[]>();
  /** Each turn's work log, in parts by the message each shows under (`splitTurn`). */
  const blocksByAnchor = new Map<
    string,
    { activity: AgentActivity; turn: TurnActivity; withReasoning: boolean; last: boolean }[]
  >();
  /** Requests shown after the agent's text that led up to them rather than with their turn. */
  const requestsByAnchor = new Map<
    string,
    { activity: AgentActivity; requests: ChatApproval[] }[]
  >();
  /** Each turn's requests that stay in its work log, by `agentId:turnId`. */
  const blockRequests = new Map<string, ChatApproval[]>();
  /** Turn-end notices shown on their turn's status row, by message id → `agentId:turnId`. */
  const foldedNotices = new Map<string, string>();
  const boundTurns = new Map(activities.map((activity) => [activity, activity.turns()]));
  for (const [activity, bound] of boundTurns) {
    for (const [messageId, turn] of bound) {
      const list = turnsByMessage.get(messageId) ?? [];
      list.push({ activity, turn });
      turnsByMessage.set(messageId, list);
    }
    for (const [anchorId, turns] of placeTurns(timeline.messages, activity.agentId, bound)) {
      for (const turn of turns) {
        const parts = splitTurn(timeline.messages, activity.agentId, bound, anchorId, turn);
        // The part that carries the turn's state, and the requests placed with it.
        const blockAnchor = parts[parts.length - 1].anchorId;
        parts.forEach((part, index) =>
          blocksByAnchor.set(part.anchorId, [
            ...(blocksByAnchor.get(part.anchorId) ?? []),
            {
              activity,
              turn: part.turn,
              withReasoning: part.reasoning,
              last: index === parts.length - 1,
            },
          ])
        );
        for (const [requestAnchor, requests] of placeRequests(
          timeline.messages,
          activity.agentId,
          bound,
          anchorId,
          turn
        )) {
          if (requestAnchor === blockAnchor)
            blockRequests.set(`${activity.agentId}:${turn.turnId}`, requests);
          else
            requestsByAnchor.set(requestAnchor, [
              ...(requestsByAnchor.get(requestAnchor) ?? []),
              { activity, requests },
            ]);
        }
      }
    }
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
  // A kickoff's one-line headline ("Kickoff from …") says what its request
  // row already shows, so the request alone stands for both.
  const kickoffHeadlines = new Set(
    timeline.messages.flatMap((message) =>
      message.kickoff && message.threadRootId ? [message.threadRootId] : []
    )
  );
  const stopRows = hiddenStopRows(timeline.messages);
  // Open requests whose turn shows under no loaded message still need an answer.
  const shownRequests = new Set(
    [...blocksByAnchor.values()].flatMap((blocks) =>
      blocks.flatMap(({ turn }) => turn.requests.map((request) => request.requestId))
    )
  );
  // Only when the conversation's start is loaded is its first agent message the first.
  const enteringId =
    entrance.firstAgent && !timeline.hasMore
      ? (timeline.messages.find(
          (message) =>
            message.sender.kind === 'agent' &&
            !isSessionStartingNotice(message) &&
            turnEndNotice(message) === null
        )?.messageId ?? null)
      : null;
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
  // Called inline, not as a component: it advances the block and spacing state in render order.
  const requestsRow = (key: string, activity: AgentActivity, requests: ChatApproval[]) => {
    const agent = agentOf(activity.agentId);
    const head = startsBlock(activity.agentId);
    return (
      <AgentRow
        key={key}
        agent={rowAgent(agent, activity.agentId, activity.agentId, serverId)}
        serverId={serverId}
        head={head}
        className={spacing(head)}
      >
        <ChatRequests
          activity={activity}
          requests={requests}
          asker={requestAsker(agent, activity.agentId)}
        />
      </AgentRow>
    );
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
        if (message.sender.kind === 'system' && kickoffHeadlines.has(message.messageId))
          return null;
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
        const agentLabel = rowAgent(agent, message.sender.agentId, message.sender.name, serverId);
        const agentRow = notice || ended !== null || message.sender.kind === 'agent';
        const head = startsBlock(agentRow ? message.sender.agentId : null);
        const kickoff = message.sender.kind === 'system' ? message.kickoff : null;
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
                      ? `${agentLabel.name} is starting a session…`
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
              <Entrance play={message.messageId === enteringOwnId} order={0}>
                <div
                  id={messageAnchorId(message.messageId)}
                  className={cn('group/row flex gap-3', spacing())}
                >
                  <PersonAvatar name={message.sender.name} userId={message.sender.userId} />
                  <div className="flex max-w-[85%] min-w-0 flex-col items-start gap-1">
                    <span className="flex items-center gap-1.5 text-xs">
                      <span className="font-medium text-foreground-muted">
                        {message.sender.name}
                      </span>
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
              </Entrance>
            ) : kickoff ? (
              <KickoffRow
                id={messageAnchorId(message.messageId)}
                className={spacing()}
                kickoff={kickoff}
                body={message.body}
                agent={agentOf(kickoff.agentId)}
                serverId={serverId}
              />
            ) : message.sender.kind === 'agent' ? (
              <Entrance play={message.messageId === enteringId} order={0}>
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
                      <ChatMarkdown>{messageText(message)}</ChatMarkdown>
                    </div>
                    <ChatAttachments
                      serverId={serverId}
                      roomId={timeline.roomId}
                      attachments={message.attachments}
                    />
                  </div>
                </AgentRow>
              </Entrance>
            ) : (
              // Switch's own lines (notices, kickoff headlines) are written in
              // the same Markdown as messages: drawn as text, `**name**` read
              // as asterisks.
              <div
                id={messageAnchorId(message.messageId)}
                className={cn('text-center text-xs text-foreground-muted', spacing())}
              >
                <ChatMarkdown>{message.body}</ChatMarkdown>
              </div>
            )}
            {(blocksByAnchor.get(message.messageId) ?? []).map(
              ({ activity, turn, withReasoning, last }) => {
                const turnAgent = agentOf(activity.agentId);
                const head =
                  turnShown(activity, turn, withReasoning) && startsBlock(activity.agentId);
                return (
                  <ChatActivityBlock
                    serverId={serverId}
                    key={`${activity.agentId}:${turn.turnId}:${message.messageId}`}
                    activity={activity}
                    turn={{
                      ...turn,
                      requests: last
                        ? (blockRequests.get(`${activity.agentId}:${turn.turnId}`) ?? [])
                        : [],
                    }}
                    withReasoning={withReasoning}
                    endReason={endReasons.get(`${activity.agentId}:${turn.turnId}`) ?? null}
                    head={head}
                    agent={rowAgent(turnAgent, activity.agentId, activity.agentId, serverId)}
                    asker={requestAsker(turnAgent, activity.agentId)}
                    className={spacing(head)}
                  />
                );
              }
            )}
            {(requestsByAnchor.get(message.messageId) ?? []).map(({ activity, requests }) =>
              requestsRow(`requests:${activity.agentId}:${requests[0].turnId}`, activity, requests)
            )}
          </Fragment>
        );
      })}
      {activities.map((activity) => {
        const requests = [...activity.approvals.values()].filter(
          (request) => request.state === 'open' && !shownRequests.has(request.requestId)
        );
        if (!requests.length) return null;
        return requestsRow(`requests:${activity.agentId}`, activity, requests);
      })}
      {timeline.pending.map((send) => (
        <Entrance key={send.requestId} play={send.requestId === enteringOwnId} order={0}>
          <PendingBubble timeline={timeline} send={send} find={find} className={spacing()} />
        </Entrance>
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
          {(send.state === 'conflict' || send.uncertain || send.error) && (
            <span className="text-foreground-destructive">
              {send.state === 'conflict'
                ? 'This request id was already used for a different message, so it was not sent. Discard it and send again.'
                : send.uncertain
                  ? `Not confirmed: ${send.error ?? 'Switch did not answer.'} Retrying sends the same message, never a second copy.`
                  : send.error}
            </span>
          )}
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

/**
 * A template's kickoff: a full request, often several paragraphs, that Switch
 * posts for whoever ran the template. It is not a notice, so it is not drawn
 * as one; and its sender is usually not in the room (switch-buddy rarely is),
 * so it is not drawn as a room member speaking either, which would invite
 * people to address it here. A card names who sent it, with that agent's own
 * picture, and folds the run history Switch appends for the agents under it.
 */
function KickoffRow({
  kickoff,
  body,
  agent,
  serverId,
  ...props
}: {
  kickoff: ChatKickoff;
  body: string;
  agent: ChatAgent | null;
  serverId: string;
  id: string;
  className: string;
}) {
  // An agent's kickoff names it as its rows do; `name` is then its unique name.
  const sender =
    kickoff.agentId !== null
      ? chatAgentNaming(
          { name: kickoff.name, displayName: kickoff.displayName ?? agent?.displayName ?? null },
          isOwnBuddy(serverId, kickoff.agentId)
        )
      : { label: kickoff.displayName ?? kickoff.name, uniqueName: null };
  return (
    <div {...props} className={cn('rounded-xl border bg-background-1 px-4 py-3', props.className)}>
      <div className="mb-1.5 flex items-center gap-2 text-xs text-foreground-muted">
        {kickoff.agentId !== null && (
          <AgentAvatar
            agentId={kickoff.agentId}
            name={sender.label}
            iconUrl={kickoff.iconUrl ?? agent?.iconUrl ?? null}
            serverId={serverId}
            size={16}
          />
        )}
        <span>
          Kickoff from <span className="font-medium text-foreground">{sender.label}</span>
          {sender.uniqueName !== null && (
            <span className="text-foreground-passive"> @{sender.uniqueName}</span>
          )}
        </span>
      </div>
      <div className="text-sm leading-relaxed">
        <ChatMarkdown>{body}</ChatMarkdown>
      </div>
      {kickoff.agentNote && (
        <details className="mt-1 text-xs text-foreground-muted">
          <summary className="cursor-pointer">Details for agents</summary>
          <div className="mt-1">
            <ChatMarkdown>{kickoff.agentNote}</ChatMarkdown>
          </div>
        </details>
      )}
    </div>
  );
}
