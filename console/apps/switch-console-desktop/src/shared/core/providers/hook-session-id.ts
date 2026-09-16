import { AGENT_PROVIDER_IDS, type AgentProviderId } from './agent-provider-registry';

export function makeHookSessionId(provider: AgentProviderId, sessionId: string): string {
  return `${provider}-session-${sessionId}`;
}

export function parseHookSessionId(id: string): { providerId: AgentProviderId; sessionId: string } | null {
  for (const providerId of AGENT_PROVIDER_IDS) {
    const prefix = `${providerId}-session-`;
    if (id.startsWith(prefix)) return { providerId, sessionId: id.slice(prefix.length) };
  }
  return null;
}
