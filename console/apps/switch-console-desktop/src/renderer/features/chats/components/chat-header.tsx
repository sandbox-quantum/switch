import { ExternalLink, FileText, MoreHorizontal, RotateCw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Fragment } from 'react';
import {
  cloudOperationAttempts,
  restartAttemptKey,
} from '@renderer/features/cloud-agents/cloud-operation-attempts';
import { openRoomChannel } from '@renderer/features/switch-rooms/room-links';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { type ChatSummary, chatAgentLabel } from '@shared/core/chats/chats';
import type { AgentActivity } from '../stores/chat-activity-store';
import { chatsStore } from '../stores/chats';
import { chatActions } from './chat-actions';

const STREAM_LABEL = {
  connecting: 'Connecting…',
  'catching-up': 'Catching up…',
  offline: 'Offline',
  live: null,
} as const;

async function restartSession(activity: AgentActivity): Promise<void> {
  const target = activity.target;
  if (target?.kind !== 'session') return;
  if (target.cloud) {
    const result = await cloudOperationAttempts.run(
      restartAttemptKey(target.hostAgentKey, target.sessionId),
      target.hostAgentKey,
      'restart',
      target.sessionId
    );
    if (!result) throw new Error('This session is already restarting.');
    if (result.outcome.state !== 'applied') throw new Error(result.outcome.message);
  } else await rpc.sessions.restartAgent(target.sessionId);
  await activity.client?.connect();
}

type HeaderProps = {
  serverId: string;
  chat: ChatSummary;
  activities: AgentActivity[];
};

/** Who and where: the chat's agents, its name and its channel. */
export function ChatHeaderTitle({ chat }: { chat: ChatSummary }) {
  const agent = chat.agents[0] ?? null;
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      {agent && <AgentAvatar name={chatAgentLabel(agent)} iconUrl={agent.iconUrl} size={18} />}
      {chat.agents.map((each, index) => (
        <Fragment key={each.id}>
          {index > 0 && <span className="text-foreground-muted">,</span>}
          <span className="truncate text-foreground-muted">{chatAgentLabel(each)}</span>
        </Fragment>
      ))}
      <span className="text-foreground-passive">/</span>
      <span className="truncate font-medium">{chat.name}</span>
      {chat.channelName && (
        <span className="truncate text-foreground-passive">· #{chat.channelName}</span>
      )}
    </div>
  );
}

/**
 * Whether an agent is working, the live feed's state, and the chat's menu —
 * its members, the room actions the person may take, and the agent's session
 * for those who can reach it.
 */
export const ChatHeaderControls = observer(function ChatHeaderControls({
  serverId,
  chat,
  activities,
}: HeaderProps) {
  const { navigate } = useNavigate();
  const working = activities.some((activity) => activity.working);
  const stream = STREAM_LABEL[chatsStore.streamState];
  const sessionActivities = activities.filter(
    (activity) => activity.target?.kind === 'session' && activity.target.target !== 'controller'
  );
  const transcripts = activities.filter(
    (activity) => activity.target?.kind === 'session' && activity.target.cloud
  );
  const channelUrl = switchRoomsStore.roomChannelUrl(chat.roomId);
  return (
    <div className="flex shrink-0 items-center gap-3 text-sm">
      {working && (
        <span className="flex items-center gap-1.5 text-xs text-foreground-muted">
          <span className="size-1.5 rounded-full bg-amber-400" aria-hidden />
          working
        </span>
      )}
      {stream && (
        <span
          className="flex items-center gap-1 text-xs text-foreground-muted"
          title={chatsStore.streamDetail ?? undefined}
        >
          {stream}
          {chatsStore.streamState === 'offline' && (
            <Button size="sm" variant="ghost" onClick={() => void rpc.chats.connect(serverId)}>
              Reconnect
            </Button>
          )}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="sm" className="size-7 p-0" />}
          aria-label={`Actions for ${chat.name}`}
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {chatActions(serverId, chat).map((action) => (
            <Fragment key={action.key}>
              {action.separatorBefore && <DropdownMenuSeparator />}
              <DropdownMenuItem
                variant={action.destructive ? 'destructive' : 'default'}
                onClick={action.run}
              >
                {action.icon}
                {action.label}
              </DropdownMenuItem>
            </Fragment>
          ))}
          {channelUrl && (
            <DropdownMenuItem onClick={() => openRoomChannel(chat.roomId)}>
              <ExternalLink className="size-4" />
              Open in {bridgePlatformLabel(chat.bridgeType)}
            </DropdownMenuItem>
          )}
          {(sessionActivities.length > 0 || transcripts.length > 0) && <DropdownMenuSeparator />}
          {sessionActivities.map((activity) => {
            const label =
              chat.agents.length > 1
                ? ` (${chatAgentLabel(chat.agents.find((each) => each.id === activity.agentId) ?? { name: activity.agentId, displayName: null })})`
                : '';
            return (
              <DropdownMenuItem
                key={`restart:${activity.agentId}`}
                disabled={activity.working}
                onClick={() =>
                  void restartSession(activity).catch((error: unknown) =>
                    toast({
                      title: failureText(error, 'Could not restart the session.'),
                      variant: 'destructive',
                    })
                  )
                }
              >
                <RotateCw className="size-4" />
                {activity.session?.status === 'stopped' ? 'Resume session' : 'Restart session'}
                {label}
              </DropdownMenuItem>
            );
          })}
          {transcripts.map((activity) => {
            const target = activity.target;
            if (target?.kind !== 'session' || !target.cloud) return null;
            return (
              <DropdownMenuItem
                key={`transcript:${activity.agentId}`}
                onClick={() =>
                  navigate('cloudSession', {
                    agentKey: target.hostAgentKey,
                    sessionId: target.sessionId,
                    name: chat.name,
                  })
                }
              >
                <FileText className="size-4" />
                Open session transcript
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});

/** The chat's header in one row: who and where on the left, its controls on the right. */
export const ChatHeader = observer(function ChatHeader(props: HeaderProps) {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
      <ChatHeaderTitle chat={props.chat} />
      <ChatHeaderControls {...props} />
    </div>
  );
});
