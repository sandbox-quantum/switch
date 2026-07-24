import type { Result } from '@switchdash/shared';
import type { Agent } from '@shared/core/agents/agents';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

/**
 * Onboarding creates an agent at a location, creating the location row first
 * if no location exists yet for (sshHost, dir). The directory must already be
 * configured as a Switch agent (its `.claude/settings.local.json` resolves an
 * identity) — minting a new identity happens before this call, via
 * `switchServers.provisionAgent` / `provisionRemoteAgent`.
 */
export type OnboardAgentParams = {
  id?: string;
  name: string;
  /** The registered Switch server the user chose for this agent. The agent must
   * exist on it — verified server-side at onboard time. */
  serverId: string;
  /** The agent type (CLI provider) the user picked when onboarding. */
  providerId: AgentProviderId;
  /** Where the agent runs: `~/.ssh/config` Host alias (omit for this machine)
   * plus the absolute working directory on that host. */
  sshHost?: string;
  dir: string;
  /** Seed for the per-agent bypass-permissions flag. Omit to take the
   * default (false for local, true for remote). */
  autoApprove?: boolean;
};

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
