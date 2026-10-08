import type { Item } from '@switch-console/shared/session-v1';
import { SquareTerminal } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { SessionV1Request } from '@renderer/features/sessions/components/transcript/session-v1-request';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { reasoningLabel } from '@shared/core/sessions/reasoning';
import { isThinking, toolState, type TurnActivity, turnTools } from '../activity-join';
import type { AgentActivity } from '../stores/chat-activity-store';
import { Reasoning } from '../ui/reasoning';
import { Shimmer } from '../ui/shimmer';
import { Tool, ToolContent, ToolHeader, ToolOutput } from '../ui/tool';

function ToolCard({ item, turn }: { item: Item; turn: TurnActivity }) {
  return (
    <Tool>
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
  );
}

/**
 * What the agent did for one room message, from its session: its reasoning
 * (local and SSH hosts only), each tool it ran, and the approvals it asks
 * for. Shown under the message that started the turn. The text the agent
 * wrote is not: its reply arrives as a room message of its own, and that is
 * the copy shown.
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
  const work = turnTools(turn);
  const thinking = isThinking(turn) && !label;
  const ended = turn.status === 'interrupted' || turn.status === 'error';
  const requests = client ? turn.requests : [];
  if (!label && !work.length && !thinking && !ended && !requests.length) return null;
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
        {work.map((item) => (
          <ToolCard key={item.itemId} item={item} turn={turn} />
        ))}
        {thinking && (
          <Shimmer className="text-sm">
            {turn.status === 'queued' ? 'Queued…' : 'Thinking…'}
          </Shimmer>
        )}
        {ended && (
          <p role="status" className="text-xs text-foreground-destructive">
            {turn.status === 'interrupted' ? 'Stopped.' : 'The turn ended with an error.'}
          </p>
        )}
        {client &&
          requests.map((request) => (
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
