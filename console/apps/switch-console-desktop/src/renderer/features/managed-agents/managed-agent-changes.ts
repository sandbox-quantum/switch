import type { RepoAgentField } from '@switch-console/core/agents/plugins';
import type { AdvancedConfigValue } from '@switch-console/plugins/agents';
import {
  attributesFromForm,
  emptyForm,
  formFromAttributes,
  type FormState,
} from '@renderer/features/locations/components/agent-definition-fields';
import type {
  AdvancedConfigField,
  ManagedAgentChanges,
  ManagedAgentView,
  OwnedMachine,
} from '@shared/core/managed-agents/managed-agents';
import { machineWorkspaceFor } from './managed-agent-state';

/**
 * The model, a definition field of its own rather than part of the provider's
 * advanced configuration, shown first among it. Keyed `model` because that is
 * the key the model catalogue and a variant field's `modelField` name.
 */
export const MODEL_FIELD: RepoAgentField = { key: 'model', label: 'Model', type: 'text' };

/** Every field the managed agent page's Advanced configuration shows, in order. */
export function managedAdvancedFields(schema: AdvancedConfigField[]): RepoAgentField[] {
  return [MODEL_FIELD, ...schema];
}

/**
 * The advanced configuration the form holds, as a definition carries it:
 * unset fields left out rather than sent empty, which the server refuses.
 */
export function advancedConfigFromForm(
  fields: AdvancedConfigField[],
  form: FormState
): Record<string, AdvancedConfigValue> {
  const config: Record<string, AdvancedConfigValue> = {};
  for (const [key, value] of Object.entries(attributesFromForm(fields, form))) {
    if (value === null || value === '' || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    config[key] = value;
  }
  return config;
}

/** A managed agent's page as edited: its identity, and its definition as one form. */
export type Draft = {
  displayName: string;
  description: string;
  iconUrl: string | null;
  instructions: string;
  autoApprove: boolean;
  /** Where it runs on its machine; empty for wherever the machine chooses. */
  directory: string;
  ownProcess: boolean;
  /** The model, and every field of the provider's schema. */
  form: FormState;
};

/**
 * The directory the page shows: the one the definition names, else the one its
 * machine reports running it in, else where the machine will make it.
 */
export function shownDirectory(agent: ManagedAgentView, machine: OwnedMachine | null): string {
  return (
    agent.definition.directory ??
    agent.status?.directory ??
    (machine ? machineWorkspaceFor(machine, agent.name) : null) ??
    ''
  );
}

export function draftOf(
  agent: ManagedAgentView,
  schema: AdvancedConfigField[],
  machine: OwnedMachine | null
): Draft {
  return {
    displayName: agent.displayName ?? '',
    description: agent.description,
    iconUrl: agent.iconUrl,
    instructions: agent.definition.instructions,
    autoApprove: agent.definition.autoApprove,
    directory: shownDirectory(agent, machine),
    ownProcess: agent.definition.isolation === 'isolated',
    form: {
      ...emptyForm(schema),
      ...formFromAttributes(schema, agent.definition.advancedConfig),
      [MODEL_FIELD.key]: agent.definition.model ?? '',
    },
  };
}

/** What a save sends: the definition and machine to the server, and the identity fields one by one. */
export type ManagedAgentEdit = {
  changes: ManagedAgentChanges;
  displayName?: string | null;
  description?: string;
  iconUrl?: string | null;
};

/**
 * What changed between the saved draft and the edited one, as the server takes
 * it. The advanced configuration goes as a whole replacement when any of its
 * fields changed; a key the schema does not name is kept, so the server judges
 * it rather than Console dropping it unseen.
 */
export function editOf(
  agent: ManagedAgentView,
  schema: AdvancedConfigField[],
  before: Draft,
  after: Draft
): ManagedAgentEdit {
  const definition: ManagedAgentChanges['definition'] = {};
  const model = String(after.form[MODEL_FIELD.key] ?? '').trim() || null;
  if (model !== (String(before.form[MODEL_FIELD.key] ?? '').trim() || null))
    definition.model = model;
  const directory = after.directory.trim() || null;
  if (directory !== (before.directory.trim() || null)) definition.directory = directory;
  if (after.ownProcess !== before.ownProcess)
    definition.isolation = after.ownProcess ? 'isolated' : 'shared';
  const advancedConfig = advancedConfigFromForm(schema, after.form);
  if (
    JSON.stringify(advancedConfig) !== JSON.stringify(advancedConfigFromForm(schema, before.form))
  ) {
    const known = new Set(schema.map((field) => field.key));
    const unknown = Object.entries(agent.definition.advancedConfig).filter(
      ([key]) => !known.has(key)
    );
    definition.advancedConfig = { ...Object.fromEntries(unknown), ...advancedConfig };
  }
  if (after.autoApprove !== before.autoApprove) definition.autoApprove = after.autoApprove;
  if (after.instructions !== before.instructions) definition.instructions = after.instructions;

  const edit: ManagedAgentEdit = { changes: { definition } };
  const displayName = after.displayName.trim() || null;
  if (displayName !== (before.displayName.trim() || null)) edit.displayName = displayName;
  if (after.description.trim() !== before.description.trim())
    edit.description = after.description.trim();
  if (after.iconUrl !== before.iconUrl) edit.iconUrl = after.iconUrl;
  return edit;
}

export function editIsEmpty(edit: ManagedAgentEdit): boolean {
  return (
    Object.keys(edit.changes.definition).length === 0 &&
    edit.changes.machineId === undefined &&
    edit.displayName === undefined &&
    edit.description === undefined &&
    edit.iconUrl === undefined
  );
}
