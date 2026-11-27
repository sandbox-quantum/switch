import { MoreVertical, RotateCw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { type ChatSummary, chatAgentLabel } from '../contracts/chats';
import { AgentAvatar, useChatHost } from '../host';
import { failureText } from '../model/failures';
import { Button } from '../primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../primitives/dropdown-menu';
import type { AgentActivity } from '../stores/chat-activity-store';
import { ChatActionItems, chatActions, type ChatRemovalContext } from './chat-actions';

const STREAM_LABEL = {
  connecting: 'Connecting…',
  'catching-up': 'Catching up…',
  offline: 'Offline',
  live: null,
} as const;

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

export const ChatHeaderControls = observer(function ChatHeaderControls({
  serverId,
  chat,
  activities,
  context,
  children,
}: {
  serverId: string;
  chat: ChatSummary;
  activities: AgentActivity[];
  context: ChatRemovalContext;
  children?: ReactNode;
}) {
  const host = useChatHost();
  const working = activities.some((activity) => activity.working);
  const stream = STREAM_LABEL[host.chats.streamState];
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
          title={host.chats.streamDetail ?? undefined}
        >
          {stream}
          {host.chats.streamState === 'offline' && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void host.reconnectFeed(serverId).catch((error: unknown) => {
                  const title = failureText(error, 'Could not reconnect the live chat feed.');
                  host.toast({ title, variant: 'destructive' });
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
          <ChatActionItems actions={chatActions(serverId, chat, context, host)} />
          {sessionActivities.length > 0 && host.restartSession && <DropdownMenuSeparator />}
          {sessionActivities.map((activity) => {
            if (!host.restartSession || activity.target?.kind !== 'session') return null;
            const sessionId = activity.target.sessionId;
            return (
              <DropdownMenuItem
                key={`restart:${activity.agentId}`}
                disabled={activity.working}
                onClick={() =>
                  void host.restartSession!(sessionId).catch((error: unknown) =>
                    host.toast({
                      title: failureText(error, 'Could not restart the session.'),
                      variant: 'destructive',
                    })
                  )
                }
              >
                <RotateCw className="size-4" />
                Restart session
              </DropdownMenuItem>
            );
          })}
          {children && <DropdownMenuSeparator />}
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});
