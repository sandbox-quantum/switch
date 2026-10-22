import { Lock, UserPlus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { SERVER_TOO_OLD_FOR_ACTIVITY } from '@shared/core/chats/activity';
import type { ChatMessage, ChatSummary } from '@shared/core/chats/chats';
import { agentActivities } from '../stores/activities';
import type { AgentActivity } from '../stores/chat-activity-store';
import type { ChatTimeline } from '../stores/chat-timeline-store';
import { chatsStore } from '../stores/chats';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerViewport,
  useMessageScroller,
} from '../ui/message-scroller';
import { ChatComposer } from './chat-composer';
import { ChatTimelineView } from './chat-timeline';

/** How often the session behind each agent is looked up again while the chat is open. */
const RESOLVE_MS = 15_000;
/** How often a running turn's reasoning is read from a local or SSH host. */
const REASONING_MS = 1500;

/** One activity per agent in the chat, held while the chat is on screen. */
export function useAgentActivities(
  serverId: string,
  chat: ChatSummary | undefined
): AgentActivity[] {
  const tenantId = chatsStore.tenantId;
  const agentIds = (chat?.agents ?? []).map((agent) => agent.id).join('\u0000');
  const roomId = chat?.roomId ?? null;
  const [activities, setActivities] = useState<AgentActivity[]>([]);
  useEffect(() => {
    if (!roomId || !agentIds) {
      setActivities([]);
      return;
    }
    const held = agentIds
      .split('\u0000')
      .map((agentId) => agentActivities.acquire(serverId, tenantId, roomId, agentId));
    setActivities(held);
    const timer = setInterval(() => {
      for (const activity of held) void activity.resolve();
    }, RESOLVE_MS);
    return () => {
      clearInterval(timer);
      for (const activity of held) agentActivities.release(activity);
    };
  }, [serverId, tenantId, roomId, agentIds]);
  return activities;
}

const Notice = ({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) => (
  <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
    {icon}
    <p className="text-sm font-medium">{title}</p>
    <p className="max-w-sm text-sm text-foreground-muted">{body}</p>
  </div>
);

/**
 * A chat: the room's messages from Switch, kept live, with each agent's
 * activity from Switch's activity feed joined under the messages that
 * started it, and a composer that posts to the
 * room.
 */
export const ChatPanel = observer(function ChatPanel({
  serverId,
  roomId,
}: {
  serverId: string;
  roomId: string;
}) {
  const timeline = chatsStore.timelines.get(serverId, roomId);
  const chat = chatsStore.chat(roomId);
  const activities = useAgentActivities(serverId, chat);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const lost = timeline.accessLost || chatsStore.removed.has(roomId);

  useEffect(() => {
    if (!timeline.loaded && !lost && !timeline.notMember) void timeline.load();
  }, [timeline, lost, timeline.notMember]);

  // Reasoning lives only on a local or SSH host and is read while a turn runs,
  // and whenever the joined turns change.
  const working = activities.some((activity) => activity.working);
  const turnIdsKey = activities
    .map((activity) => [...activity.turns().values()].map((turn) => turn.turnId).join(','))
    .join('|');
  const activeTurnsKey = activities
    .map((activity) =>
      [...activity.turns().values()]
        .filter((turn) => turn.status === 'running' || turn.status === 'queued')
        .map((turn) => turn.turnId)
        .join(',')
    )
    .join('|');
  // The answer carries tool output too, so a tick reads only the turns still
  // running; every turn is read again whenever the set of running turns changes.
  useEffect(() => {
    const read = (activeOnly: boolean) => {
      for (const activity of activities) {
        const turns = [...activity.turns().values()].filter(
          (turn) => !activeOnly || turn.status === 'running' || turn.status === 'queued'
        );
        void activity.readReasoning(turns.slice(-20));
      }
    };
    read(false);
    if (!working) return;
    const timer = setInterval(() => read(true), REASONING_MS);
    return () => clearInterval(timer);
  }, [activities, working, turnIdsKey, activeTurnsKey]);

  if (lost)
    return (
      <Notice
        icon={<Lock className="size-5 text-foreground-muted" />}
        title="You no longer have access to this chat"
        body="You were removed from it, left it, or lost your role in this workspace. Its messages are no longer shown here."
      />
    );
  if (timeline.notMember)
    return (
      <Notice
        icon={<UserPlus className="size-5 text-foreground-muted" />}
        title="You are not in this chat"
        body="Ask the room owner to invite you. Being able to see a room does not let you read its conversation."
      />
    );

  return (
    <div data-chat-panel className="flex h-full min-h-0 flex-col bg-background text-foreground">
      {timeline.loadError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 bg-background-1 px-5 py-2 text-sm"
        >
          <span>{timeline.loadError}</span>
          <Button size="sm" variant="outline" onClick={() => timeline.retryLoad()}>
            Try again
          </Button>
        </div>
      )}
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-[860px] gap-0 px-5 py-6">
            {!timeline.loaded && timeline.loading ? (
              <p className="text-sm text-foreground-muted">Loading the conversation…</p>
            ) : (
              <ChatTimelineView
                serverId={serverId}
                timeline={timeline}
                agents={chat?.agents ?? []}
                activities={activities}
                onReply={setReplyTo}
              />
            )}
            {timeline.loaded && timeline.messages.length === 0 && timeline.pending.length === 0 && (
              <p className="mt-10 text-center text-sm text-foreground-muted">
                No messages yet. Say what you need below.
              </p>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-linear-to-t from-background to-transparent"
        />
        <MessageScrollerButton className="absolute bottom-3 left-1/2 -translate-x-1/2" />
        <FollowOwnSends timeline={timeline} />
      </MessageScroller>
      <ActivityUnavailable serverId={serverId} activities={activities} />
      <ChatComposer
        serverId={serverId}
        timeline={timeline}
        agents={chat?.agents ?? []}
        activity={activities[0] ?? null}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        disabled={
          chatsStore.streamState === 'offline' && !timeline.loaded
            ? 'Switch cannot be reached right now.'
            : null
        }
      />
    </div>
  );
});

/**
 * Sending from here jumps to the end and resumes following, wherever the
 * reader had scrolled to: what they just sent is what they want to see.
 */
const FollowOwnSends = observer(function FollowOwnSends({ timeline }: { timeline: ChatTimeline }) {
  const { scrollToEnd } = useMessageScroller();
  const latest = timeline.pending.at(-1)?.requestId ?? null;
  const seen = useRef(latest);
  useEffect(() => {
    if (latest === null || latest === seen.current) return;
    seen.current = latest;
    scrollToEnd();
  }, [latest, scrollToEnd]);
  return null;
});

/**
 * Why an agent's activity may be missing or stale: the live activity feed is
 * down, or a snapshot read or host lookup failed.
 */
const ActivityUnavailable = observer(function ActivityUnavailable({
  serverId,
  activities,
}: {
  serverId: string;
  activities: AgentActivity[];
}) {
  const feedDown = activities.length > 0 && agentActivities.feedDown.has(serverId);
  const tooOld = agentActivities.feedDown.get(serverId) === SERVER_TOO_OLD_FOR_ACTIVITY;
  const notes = activities.flatMap((activity) =>
    [activity.feedError, activity.resolveError, activity.reasoningError].filter(
      (note) => note !== null
    )
  );
  const unique = [...new Set(notes)].filter(
    (note) => !(feedDown && tooOld && note === SERVER_TOO_OLD_FOR_ACTIVITY)
  );
  return (
    <>
      {feedDown && (
        <p
          role="status"
          title={agentActivities.feedDown.get(serverId) ?? undefined}
          className="mx-auto w-full max-w-[860px] px-5 pb-1 text-xs text-foreground-warning"
        >
          {tooOld
            ? SERVER_TOO_OLD_FOR_ACTIVITY
            : 'Live activity is reconnecting — progress may be stale.'}
        </p>
      )}
      {unique.length > 0 && (
        <p
          role="alert"
          className="mx-auto w-full max-w-[860px] px-5 pb-1 text-xs text-foreground-destructive"
        >
          {unique.join(' ')}
        </p>
      )}
    </>
  );
});
