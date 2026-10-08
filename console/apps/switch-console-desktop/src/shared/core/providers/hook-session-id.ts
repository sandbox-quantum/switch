import type { AgentProviderId } from './agent-provider-registry';

export function makeHookSessionId(provider: AgentProviderId, sessionId: string): string {
  return `${provider}-session-${sessionId}`;
}
