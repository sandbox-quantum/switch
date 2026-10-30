import type { ReactNode } from 'react';
import { useAgentAccent } from '@renderer/lib/components/agent-accent';
import { cn } from '@renderer/utils/utils';
import type { ChatAgent } from '@shared/core/chats/chats';
import { MENTION_BADGE } from '../mentions';

/**
 * A mention badge tinted with its agent's avatar colour, neutral until that is
 * known or when there is none. Background and an outer ring only: it sits
 * behind the composer's text, so it must not change the text's width.
 */
export function MentionMark({
  kind,
  agent,
  serverId,
  className,
  children,
}: {
  kind: 'agent' | 'person';
  /** The agent mentioned; null for a person, whose badge is never tinted. */
  agent: ChatAgent | null;
  serverId: string;
  className: string;
  children: ReactNode;
}) {
  const accent = useAgentAccent(agent, serverId);
  const tint = accent ? `color-mix(in srgb, ${accent} 18%, transparent)` : null;
  return (
    <mark
      data-mention={kind}
      className={cn(tint ? 'rounded-sm' : MENTION_BADGE, className)}
      style={tint ? { backgroundColor: tint, boxShadow: `0 0 0 2px ${tint}` } : undefined}
    >
      {children}
    </mark>
  );
}
