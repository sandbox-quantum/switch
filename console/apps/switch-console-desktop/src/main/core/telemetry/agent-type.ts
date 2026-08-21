import {
  isValidProviderId,
  type AgentProviderId,
} from '@shared/core/providers/agent-provider-registry';

/**
 * A provider id, checked rather than trusted.
 *
 * The column it comes from is typed but not constrained, and some callers pass a
 * dependency id that may name no agent at all — so an unrecognised value is
 * reported as unrecognised and never passed through as free text.
 *
 * Kept apart from the location helper deliberately: this is a pure function, and
 * living beside one that reads the database made every caller import the
 * database with it.
 */
export function agentTypeOf(providerId: string): AgentProviderId | 'unknown' {
  return isValidProviderId(providerId) ? providerId : 'unknown';
}
