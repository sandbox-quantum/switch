import type { Result } from '@switch-console/shared';
import type { OnboardAgentError } from '@shared/core/agents/onboarding';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

interface BaseModeData {
  name: string;
  /** Local working directory. Omitted for a remote agent (see `remote`). */
  path?: string;
}

export interface PickModeData extends BaseModeData {
  mode: 'pick';
  /** The registered Switch server the user chose for this agent. */
  serverId: string;
  /** The agent type (CLI provider) the user picked when onboarding. */
  providerId: AgentProviderId;
  /** When set, the agent runs at a remote location on this SSH host + dir. */
  remote?: { sshHost: string; dir: string };
  /** Seed for the per-agent bypass-permissions flag. Omit to take the default
   * (false for local, true for remote). */
  autoApprove?: boolean;
}

export type ModeData = PickModeData;

export type AgentOnboardingError = OnboardAgentError;

export type AgentOnboardingCompletion = Result<void, AgentOnboardingError>;

export type StartAgentOnboardingResult =
  | { kind: 'existing'; locationId: string }
  | { kind: 'creating'; locationId: string; completion: Promise<AgentOnboardingCompletion> };

export interface StartAgentOnboardingOptions {
  id?: string;
}
