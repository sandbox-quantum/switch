import type { Result } from '@switchdash/shared';
import type { Agent } from '@shared/core/agents/agents';

/**
 * How adopting an existing agent at a location can fail. Shared by the attach
 * path (`attachConfiguredAgents`) and the definition path
 * (`onboardLocationAgents`).
 */
export type OnboardAgentError =
  | { type: 'invalid-directory'; dir: string; message: string }
  /** The chosen Switch server does not have this agent — the user picked the
   * wrong server, or the directory's `SWITCH_AGENT_ID` isn't registered there. */
  | {
      type: 'switch-agent-not-on-server';
      dir: string;
      serverId: string;
      serverName: string;
      agentId: string;
    }
  /** The chosen Switch server is registered but this app is not signed in to it. */
  | {
      type: 'switch-server-unauthenticated';
      dir: string;
      serverId: string;
      serverName: string;
    }
  | { type: 'error'; message: string };

export type OnboardAgentResult = Result<Agent, OnboardAgentError>;
