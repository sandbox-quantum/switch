import type { SubagentAttributes } from '@switchdash/core/agents/plugins';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { resolveSubagentFs } from './resolve-subagent-fs';

export type EditSubagentParams = {
  /** The parent agent whose subagent definition to rewrite. */
  parentAgentId: string;
  /** The subagent's attributes. `name` is the agent's identity and immutable, so
   * it only selects which definition to rewrite. */
  attributes: SubagentAttributes;
};

/**
 * Update an existing subagent's definition in place from the given attributes.
 * The name is the agent's Switch identity and so is immutable here; it only
 * selects the definition to rewrite. Resolves the parent's working directory
 * (local or remote) from the agent.
 */
export async function editSubagent(params: EditSubagentParams): Promise<void> {
  const name = typeof params.attributes.name === 'string' ? params.attributes.name.trim() : '';
  if (!name) throw new Error('A subagent name is required.');

  const ctx = await resolveSubagentFs(params.parentAgentId);
  try {
    const behavior = getPlugin(ctx.agent.providerId).behavior.subagents;
    if (!behavior) {
      throw new Error(`Provider ${ctx.agent.providerId} does not support subagents.`);
    }

    if (!(await behavior.readDefinition(ctx.fs, name))) {
      throw new Error(`No subagent definition named "${name}".`);
    }

    await behavior.writeDefinition(ctx.fs, params.attributes);
  } finally {
    ctx.close();
  }
}
