import type { Result } from '@switchdash/shared';
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
