import { MoreVertical, RotateCw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { log } from '@renderer/utils/logger';
import { type ChatSummary, chatAgentLabel } from '@shared/core/chats/chats';
import type { AgentActivity } from '../stores/chat-activity-store';
import { chatsStore } from '../stores/chats';
import { ChatActionItems, chatActions } from './chat-actions';

const STREAM_LABEL = {
  connecting: 'Connecting…',
  'catching-up': 'Catching up…',
  offline: 'Offline',
  live: null,
} as const;

async function restartSession(activity: AgentActivity): Promise<void> {
  const target = activity.target;
  if (target?.kind !== 'session') return;
  await rpc.sessions.restartAgent(target.sessionId);
}

/** Who and where: the chat's agent and its name. */
export function ChatHeaderTitle({ serverId, chat }: { serverId: string; chat: ChatSummary }) {
  const agent = chat.agents[0] ?? null;
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      {agent && (
        <AgentAvatar
          name={chatAgentLabel(agent)}
          iconUrl={agent.iconUrl}
          serverId={serverId}
          size={18}
        />
      )}
      {agent && <span className="truncate text-foreground-muted">{chatAgentLabel(agent)}</span>}
      <span className="text-foreground-passive">/</span>
      <span className="truncate font-medium">{chat.name}</span>
    </div>
  );
}

/**
 * Whether the agent is working, the live feed's state, and the chat's menu —
 * the chat actions the person may take, and the agent's session for those who
 * can reach it, then any `children` after a separator.
 */
export const ChatHeaderControls = observer(function ChatHeaderControls({
  serverId,
  chat,
  activities,
  children,
}: {
  serverId: string;
  chat: ChatSummary;
  activities: AgentActivity[];
  children?: ReactNode;
}) {
  const working = activities.some((activity) => activity.working);
  const stream = STREAM_LABEL[chatsStore.streamState];
  const sessionActivities = activities.filter((activity) => activity.target?.kind === 'session');
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
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void rpc.chats.connect(serverId).catch((error: unknown) => {
                  const title = failureText(error, 'Could not reconnect the live chat feed.');
                  log.warn('Chat feed reconnect failed', { serverId, error: title });
                  toast({ title, variant: 'destructive' });
                })
              }
            >
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
          <MoreVertical className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <ChatActionItems actions={chatActions(serverId, chat)} />
          {sessionActivities.length > 0 && <DropdownMenuSeparator />}
          {sessionActivities.map((activity) => (
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
              Restart session
            </DropdownMenuItem>
          ))}
          {children && <DropdownMenuSeparator />}
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});
