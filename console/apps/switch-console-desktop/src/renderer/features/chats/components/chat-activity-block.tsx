import { SquareTerminal } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { SessionV1Request } from '@renderer/features/sessions/components/transcript/session-v1-request';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { reasoningLabel } from '@shared/core/sessions/reasoning';
import { isThinking, toolState, type TurnActivity } from '../activity-join';
import type { AgentActivity } from '../stores/chat-activity-store';
import { ChatMarkdown } from '../ui/chat-markdown';
import { Reasoning } from '../ui/reasoning';
import { Shimmer } from '../ui/shimmer';
import { Tool, ToolContent, ToolHeader, ToolOutput } from '../ui/tool';

/**
 * What the agent did for one room message, from its session: its reasoning
 * (local and SSH hosts only), each tool it ran, the text it wrote, and the
 * approvals it asks for. Shown under the message that started the turn; the
 * agent's reply to the room arrives as a room message of its own.
 */
export const ChatActivityBlock = observer(function ChatActivityBlock({
  activity,
  turn,
  agent,
}: {
  activity: AgentActivity;
  turn: TurnActivity;
  agent: { name: string; iconUrl: string | null };
}) {
  const running = turn.status === 'queued' || turn.status === 'running';
  const reasoning = activity.reasoning.get(turn.turnId) ?? null;
  const label = reasoningLabel(reasoning, running && reasoning !== null);
  const client = activity.client;
  const connected = activity.view?.connected ?? false;
  return (
    <div className="flex gap-3" data-turn-id={turn.turnId}>
      <AgentAvatar name={agent.name} iconUrl={agent.iconUrl} size={28} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {label && (
          <Reasoning
            label={label.label}
            shimmer={running && !reasoning?.completedAt}
            text={reasoning?.text ?? ''}
          />
        )}
        {turn.items.map((item) =>
          item.kind === 'tool-activity' ? (
            <Tool key={item.itemId}>
              <ToolHeader
                title={item.title}
                state={toolState(item, turn.status)}
                icon={<SquareTerminal className="size-3.5" />}
              />
              {item.text && (
                <ToolContent>
                  <ToolOutput>{item.text}</ToolOutput>
                </ToolContent>
              )}
            </Tool>
          ) : (
            <div key={item.itemId} className="text-sm leading-relaxed">
              <ChatMarkdown>{item.text}</ChatMarkdown>
            </div>
          )
        )}
        {isThinking(turn) && !label && (
          <Shimmer className="text-sm">
            {turn.status === 'queued' ? 'Queued…' : 'Thinking…'}
          </Shimmer>
        )}
        {(turn.status === 'interrupted' || turn.status === 'error') && (
          <p role="status" className="text-xs text-foreground-destructive">
            {turn.status === 'interrupted' ? 'Stopped.' : 'The turn ended with an error.'}
          </p>
        )}
        {client &&
          turn.requests.map((request) => (
            <SessionV1Request
              key={request.requestId}
              request={request}
              client={client}
              connected={connected}
            />
          ))}
      </div>
    </div>
  );
});
