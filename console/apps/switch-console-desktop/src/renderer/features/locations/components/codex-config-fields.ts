import type { RepoAgentField } from '@switch-console/core/agents/plugins';
import type { AgentProviderConfig } from '@shared/core/agents/agent-provider-config';
import { attributesFromForm, type FormState } from './agent-definition-fields';

/**
 * Turn the add-agent modal's Codex form into the config stored on the new agent.
 *
 * Only the create path needs this: it assembles the value client-side to hand to
 * `addAgent`, before an agent row exists. Editing an existing agent goes through
 * the advanced-configuration editor, which posts attributes and lets the main
 * process map them (`agent-advanced-config.ts`).
 *
 * The fields themselves are declared by the codex plugin beside the profile
 * builder that consumes them, and reach the renderer over RPC — so there is one
 * list, and the renderer still needs no plugin import.
 *
 * Null when every field is blank: an agent that specializes nothing gets no
 * profile and no `--profile` argv, rather than an empty one.
 */
export function codexConfigFromForm(
  fields: RepoAgentField[],
  state: FormState
): AgentProviderConfig | null {
  const attrs = attributesFromForm(fields, state);
  const str = (value: unknown): string | undefined => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed ? trimmed : undefined;
  };
  const model = str(attrs.model);
  const effort = str(attrs.effort);
  const instructions = str(attrs.instructions);
  if (!model && !effort && !instructions) return null;
  return { version: '1', model, effort, instructions };
}
