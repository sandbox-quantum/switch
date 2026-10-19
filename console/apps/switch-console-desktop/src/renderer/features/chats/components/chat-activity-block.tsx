import { observer } from 'mobx-react-lite';
import { type ComponentProps, type ReactNode, useState } from 'react';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { cn } from '@renderer/utils/utils';
import type { ChatActivityItem, ChatApproval } from '@shared/core/chats/activity';
import { reasoningLabel } from '@shared/core/sessions/reasoning';
import { isThinking, toolState, type TurnActivity, turnTools } from '../activity-join';
import type { AgentActivity } from '../stores/chat-activity-store';
import { presentTool, summarizeTools } from '../tool-presentation';
import { Reasoning } from '../ui/reasoning';
import { FailedIcon, ThinkingIcon, ToolKindIcon, WorkLogDetails, WorkLogRow } from '../ui/work-log';
import { ChatApprovalCard } from './chat-approval-card';
import { ToolRow } from './tool-row';

/** A settled turn with at least this many tool calls folds them behind one summary line. */
const GROUP_AT = 2;

function ToolRows({
  items,
  turn,
  activity,
}: {
  items: ChatActivityItem[];
  turn: TurnActivity;
  activity: AgentActivity;
}) {
  return (
    <>
      {items.map((item) => (
        <ToolRow
          key={item.itemId}
          item={item}
          state={toolState(item, turn.status)}
          detail={activity.toolDetails.get(item.itemId) ?? null}
        />
      ))}
    </>
  );
}

/**
 * A finished turn's tool calls as one line ("Ran 2 commands and read 3
 * files"), opening to the calls themselves. A failure is named on the line so
 * it is not hidden by the fold.
 */
function ToolGroup({
  items,
  turn,
  activity,
}: {
  items: ChatActivityItem[];
  turn: TurnActivity;
  activity: AgentActivity;
}) {
  const [open, setOpen] = useState(false);
  const summary = summarizeTools(
    items.map((item) => presentTool(item, activity.toolDetails.get(item.itemId) ?? null).kind)
  );
  const failed = items.filter((item) => toolState(item, turn.status) === 'failed').length;
  return (
    <WorkLogRow
      icon={<ToolKindIcon kind={summary.kind} />}
      label={summary.label}
      trailing={
        failed > 0 ? (
          <span className="shrink-0 text-xs text-foreground-destructive">{failed} failed</span>
        ) : null
      }
      open={open}
      onToggle={() => setOpen(!open)}
    >
      {open && (
        <div className="ms-3 border-l border-border ps-2">
          <ToolRows items={items} turn={turn} activity={activity} />
        </div>
      )}
    </WorkLogRow>
  );
}

/** How a turn ended, with the host's reason for it muted after it. */
export function turnEndLabel(label: string, reason: string | null): ReactNode {
  if (!reason) return label;
  return (
    <>
      {label}
      <span className="text-foreground-passive"> — {reason}</span>
    </>
  );
}

/**
 * One row of an agent's block in the timeline. The first row of the block
 * carries the avatar and the agent's name; the rows after it keep the indent.
 */
export function AgentRow({
  agent,
  serverId,
  head,
  trailing,
  className,
  children,
  ...props
}: ComponentProps<'div'> & {
  agent: { name: string; iconUrl: string | null };
  serverId: string;
  head: boolean;
  trailing?: ReactNode;
}) {
  return (
    <div className={cn('flex gap-3', className)} {...props}>
      {head ? (
        <AgentAvatar name={agent.name} iconUrl={agent.iconUrl} serverId={serverId} size={28} />
      ) : (
        <span className="w-7 shrink-0" aria-hidden />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {head && (
          <span className="mb-1 text-xs leading-4 font-semibold text-foreground-muted">
            {agent.name}
          </span>
        )}
        {children}
      </div>
      {trailing}
    </div>
  );
}

/** Whether a turn has anything to show in its work log. */
export function turnShown(activity: AgentActivity, turn: TurnActivity): boolean {
  const running = turn.status === 'queued' || turn.status === 'running';
  const reasoning = activity.reasoning.get(turn.turnId) ?? null;
  const work = turnTools(turn);
  return (
    reasoningLabel(reasoning, running && reasoning !== null) !== null ||
    work.length > 0 ||
    isThinking(turn) ||
    turn.status === 'interrupted' ||
    turn.status === 'error' ||
    turn.requests.length > 0
  );
}

/**
 * What the agent did for one room message, from Switch's activity feed: its
 * reasoning (local and SSH hosts only, read from the host), each tool it ran,
 * and the requests it put to people, as a compact work log under the message that started the turn. The
 * text the agent wrote is not shown: its reply arrives as a room message of
 * its own, and that is the copy shown.
 */
export const ChatActivityBlock = observer(function ChatActivityBlock({
  activity,
  turn,
  agent,
  head,
  endReason,
  serverId,
  className,
}: {
  activity: AgentActivity;
  turn: TurnActivity;
  agent: { name: string; iconUrl: string | null };
  /** Whether this turn starts the agent's block, so shows its avatar and name. */
  head: boolean;
  /** Why the turn ended, from the host's notice in the room; null when it posted none. */
  endReason: string | null;
  serverId: string;
  className?: string;
}) {
  const running = turn.status === 'queued' || turn.status === 'running';
  const reasoning = activity.reasoning.get(turn.turnId) ?? null;
  const label = reasoningLabel(reasoning, running && reasoning !== null);
  const work = turnTools(turn);
  const thinking = isThinking(turn) && !(label && !reasoning?.completedAt);
  const ended = turn.status === 'interrupted' || turn.status === 'error';
  const requests = turn.requests;
  if (!turnShown(activity, turn)) return null;
  return (
    <AgentRow
      agent={agent}
      serverId={serverId}
      head={head}
      data-turn-id={turn.turnId}
      className={className}
    >
      {label && (
        <Reasoning
          label={label.label}
          shimmer={running && !reasoning?.completedAt}
          text={reasoning?.text ?? ''}
        />
      )}
      {!running && work.length >= GROUP_AT ? (
        <ToolGroup items={work} turn={turn} activity={activity} />
      ) : (
        <ToolRows items={work} turn={turn} activity={activity} />
      )}
      {thinking && (
        <WorkLogRow
          icon={<ThinkingIcon />}
          label={turn.status === 'queued' ? 'Queued…' : 'Thinking…'}
          active
        />
      )}
      {ended && (
        <div role="status">
          <WorkLogRow
            icon={<FailedIcon />}
            label={turnEndLabel(
              turn.status === 'interrupted' ? 'Stopped' : 'The turn ended with an error',
              endReason
            )}
            title={endReason ?? undefined}
            tone="failed"
          />
        </div>
      )}
      {requests.length > 0 && <ChatRequests activity={activity} requests={requests} />}
    </AgentRow>
  );
});

/** Requests answered through Switch as the signed-in person. */
export const ChatRequests = observer(function ChatRequests({
  activity,
  requests,
}: {
  activity: AgentActivity;
  requests: ChatApproval[];
}) {
  return (
    <WorkLogDetails>
      {requests.map((request) => (
        <ChatApprovalCard
          key={request.requestId}
          request={request}
          onAnswer={(answer) => activity.answer(request, answer)}
        />
      ))}
    </WorkLogDetails>
  );
});
