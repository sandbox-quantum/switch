import { Bot } from 'lucide-react';
import { providerDisplayName } from '@shared/core/providers/agent-provider-registry';
import { AgentIcon } from './agent-icon';

/**
 * The mark of what an agent runs, with a fallback for an agent whose provider
 * this install cannot resolve.
 *
 * Every picker that lists agents wants the same pair — this mark and the name
 * beside it — and each had grown its own copy. One copy means a provider
 * without an icon looks the same everywhere rather than only where someone
 * remembered the fallback.
 */
export function AgentMark({
  providerId,
  size = 16,
}: {
  /** Null when the agent is known to Switch but not to this install. */
  providerId: string | null;
  size?: number;
}) {
  if (!providerId) return <Bot className="size-4 shrink-0 text-foreground-muted" />;
  return <AgentIcon id={providerId} size={size} />;
}

/** What to call an agent's provider in a list — "Claude Code", "Codex". */
export function agentProviderLabel(providerId: string | null | undefined): string {
  return (providerId ? providerDisplayName(providerId) : null) ?? 'Agent';
}
