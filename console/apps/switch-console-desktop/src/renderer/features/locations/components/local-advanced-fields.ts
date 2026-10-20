import type { RepoAgentAttributes, RepoAgentField } from '@switch-console/core/agents/plugins';
import { MODEL_FIELD } from '@renderer/features/managed-agents/managed-agent-changes';
import type {
  AgentAdvancedSettings,
  AgentAdvancedSurface,
} from '@shared/core/agents/agent-advanced-settings';
import type { AdvancedConfigField } from '@shared/core/managed-agents/managed-agents';

/**
 * The "Advanced configuration" of an agent this Console runs: the model, when
 * its provider keeps per-agent settings, then the fields the agent's Switch
 * server defines for its provider that the provider's plugin applies.
 *
 * The server is the only place the fields are defined. When they cannot be
 * read the form says why and offers only the model, rather than a copy of
 * them; a provider the server lists with no fields offers no more than the
 * model, and one that keeps no per-agent settings offers nothing.
 */
export type LocalAdvancedFields = {
  /** Where the provider keeps the settings; undefined until known. */
  surface: AgentAdvancedSurface | undefined;
  /** The fields to render, in order; empty until the server's are known. */
  fields: RepoAgentField[];
  /** Why the form is not the whole of what the server defines, said for a person. */
  problem: string | null;
};

/** What is known of the server's fields for the provider. */
export type ServerFields =
  | { kind: 'no-server' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'schema'; schema: Record<string, AdvancedConfigField[]> };

/** The fields and problem for what is known of the plugin's settings and the server's fields. Pure. */
export function localAdvancedFields(
  provider: { id: string; label: string },
  settings: AgentAdvancedSettings,
  server: ServerFields
): Omit<LocalAdvancedFields, 'surface'> {
  const providerLabel = provider.label;
  const model = settings.surface === 'none' ? [] : [MODEL_FIELD];
  switch (server.kind) {
    case 'loading':
      return { fields: [], problem: null };
    case 'no-server':
      return {
        fields: model,
        problem: `There is no Switch server to read the advanced configuration fields from${onlyModel(settings)}.`,
      };
    case 'error':
      return { fields: model, problem: server.message };
    case 'schema': {
      const offered = server.schema[provider.id];
      if (!offered)
        return {
          fields: model,
          problem: `The Switch server does not list ${providerLabel}, so it defines no advanced configuration for it.`,
        };
      const applied = offered.filter((field) => settings.keys.includes(field.key));
      const unapplied = offered.filter((field) => !settings.keys.includes(field.key));
      return {
        fields: [...model, ...applied],
        problem:
          unapplied.length === 0
            ? null
            : `The Switch server defines settings this version of Console cannot apply for ${providerLabel}: ${unapplied.map((field) => field.label).join(', ')}. Update Console to set them.`,
      };
    }
  }
}

/** How a problem ends: what the form still offers, when it offers the model. */
export function onlyModel(settings: AgentAdvancedSettings): string {
  return settings.surface === 'none' ? '' : ', so only the model can be set';
}

/**
 * The saved choices the server's fields do not offer, said for a person, or
 * null when there are none: a value typed into a definition by hand is kept
 * as written, and a choice list would otherwise show it as nothing chosen.
 */
export function choicesNotOffered(
  fields: RepoAgentField[],
  attributes: RepoAgentAttributes
): string | null {
  const off = fields.flatMap((field) => {
    const value = attributes[field.key];
    if (field.type !== 'select' || typeof value !== 'string' || value === '') return [];
    return (field.options ?? []).some((option) => option.value === value)
      ? []
      : [`${field.label} is “${value}”`];
  });
  return off.length === 0
    ? null
    : `${off.join('; ')}, which the Switch server does not offer. Choose another value or leave it unset.`;
}
