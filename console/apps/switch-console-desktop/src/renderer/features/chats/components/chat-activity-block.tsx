import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { type ComponentProps, type ReactNode, useEffect, useState } from 'react';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/utils/utils';
import type { ChatActivityItem, ChatApproval } from '@shared/core/chats/activity';
import { reasoningLabel } from '@shared/core/sessions/reasoning';
import { isThinking, toolState, type TurnActivity, turnTools } from '../activity-join';
import type { AgentActivity } from '../stores/chat-activity-store';
import { presentTool, summarizeTools } from '../tool-presentation';
import { Reasoning } from '../ui/reasoning';
import { CancelledIcon, FailedIcon, ThinkingIcon, ToolKindIcon, WorkLogDetails, WorkLogRow } from '../ui/work-log';
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

/** The host's warnings during a turn (a model it could not use, say), which the work log shows. */
export function turnWarnings(turn: TurnActivity): ChatActivityItem[] {
  return turn.items.filter((item) => item.kind === 'notice' && item.status === 'warning');
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
    turn.status === 'cancelled' ||
    turn.status === 'error' ||
    turn.requests.length > 0 ||
    turnWarnings(turn).length > 0
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
  const ended = turn.status === 'interrupted' || turn.status === 'cancelled' || turn.status === 'error';
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
      {turnWarnings(turn).map((notice) => (
        <WorkLogRow
          key={notice.itemId}
          icon={<FailedIcon />}
          label={notice.title}
          title={notice.text}
          tone="passive"
        />
      ))}
      {thinking && (
        <WorkLogRow
          icon={<ThinkingIcon />}
          label={
            turn.status === 'queued' ? (
              <>
                Queued… <span className="text-foreground-passive font-mono text-[10px]">({turn.turnId})</span>
              </>
            ) : (
              'Thinking…'
            )
          }
          active
        />
      )}
      {ended && (
        <div role="status">
          <WorkLogRow
            icon={turn.status === 'cancelled' ? <CancelledIcon /> : <FailedIcon />}
            label={turnEndLabel(
              turn.status === 'cancelled'
                ? 'Cancelled'
                : turn.status === 'interrupted'
                  ? 'Stopped'
                  : 'The turn ended with an error',
              endReason
            )}
            title={endReason ?? undefined}
            tone={turn.status === 'cancelled' ? 'passive' : 'failed'}
          />
          {turn.status === 'error' && turn.messageId && (
            <RetryTurn activity={activity} turn={turn} />
          )}
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

/** How long a posted retry waits for its new turn before it is said to have gone unanswered. */
export const RETRY_UNANSWERED_MS = 20_000;

/** The text shown in place of Retry when the agent's session cannot run a turn again. */
export const RETRY_UNSUPPORTED_TEXT =
  "This agent's Switch Console is too old to retry; ask its owner to update.";

/**
 * Run again the turn a message started, which failed: the same message goes to
 * the agent again, and nothing is posted in its name. Offered only when the
 * session here says it can; for one this Console does not host it is offered,
 * and a retry no new turn follows says so.
 */
const RetryTurn = observer(function RetryTurn({
  activity,
  turn,
}: {
  activity: AgentActivity;
  turn: TurnActivity;
}) {
  const target = activity.target;
  const support = useQuery({
    queryKey: [
      'chat-retry-support',
      target?.kind === 'session' ? target.hostAgentKey : null,
      target?.kind === 'session' ? target.sessionId : null,
    ],
    queryFn: () => activity.retrySupport(),
    // A lookup that failed leaves no session to ask: offered, and the fallback says if it went unheard.
    enabled: target !== null || activity.resolveError !== null,
  });
  const request = activity.retries.get(turn.turnId) ?? null;
  const [now, setNow] = useState(() => Date.now());
  const waitingSince = request?.state === 'requested' ? request.requestedAt : null;
  useEffect(() => {
    if (waitingSince === null) return;
    const left = waitingSince + RETRY_UNANSWERED_MS - Date.now();
    const timer = setTimeout(() => setNow(Date.now()), Math.max(left, 0));
    return () => clearTimeout(timer);
  }, [waitingSince]);

  if (support.data === 'no')
    return <p className="mt-1 text-xs text-foreground-muted">{RETRY_UNSUPPORTED_TEXT}</p>;
  const unanswered = waitingSince !== null && now - waitingSince >= RETRY_UNANSWERED_MS;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <Button
        size="xs"
        variant="outline"
        disabled={
          !support.isSuccess ||
          request?.state === 'sending' ||
          (waitingSince !== null && !unanswered)
        }
        onClick={() => void activity.retry(turn)}
      >
        {request?.state === 'sending'
          ? 'Retrying…'
          : waitingSince !== null && !unanswered
            ? 'Retry asked'
            : 'Retry'}
      </Button>
      {(request?.state === 'failed' || request?.state === 'unknown') && request.error && (
        <span role="alert" className="text-xs text-destructive">
          {request.error}
        </span>
      )}
      {unanswered && (
        <span role="status" className="text-xs text-foreground-muted">
          The agent did not pick up the retry. Its machine may need a newer Switch Console.
        </span>
      )}
    </div>
  );
});
