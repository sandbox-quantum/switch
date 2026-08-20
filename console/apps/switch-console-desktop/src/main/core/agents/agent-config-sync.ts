import type {
  IRepoAgentsBehavior,
  PluginFs,
  RepoAgentAttributes,
} from '@switch-console/core/agents/plugins';
import type { AgentConfigFile } from './agent-config-file';
import {
  decideArtifactSync,
  fingerprintArtifact,
  readAgentConfigFile,
  writeAgentConfigFile,
} from './agent-config-file';

/**
 * Reconcile an agent's config file with the provider definition generated from
 * it (CHOO-2228).
 *
 * The config file is the source of truth, so normally the definition is
 * generated from it. The exception is deliberate: Claude Code's subagent file
 * is a normal repository file that people edit directly, and those edits are
 * read back into the config rather than overwritten.
 *
 * Which of the two happened is decided by the fingerprint recorded the last
 * time this app generated the definition — see `decideArtifactSync`. Comparing
 * the file against what the config generates *now* cannot tell the two apart.
 *
 * Providers whose per-agent files are rebuilt from scratch at every launch
 * (Codex, OpenCode) have nothing to reconcile: their files live outside the
 * repository and are outputs only, so this is a no-op for them.
 */
export type AgentConfigSyncResult = {
  /** The config after reconciliation — what callers should read from. */
  config: AgentConfigFile;
  /** What was done, for logging and for telling the user when edits were taken
   * from the definition rather than written to it. */
  action: 'written' | 'adopted' | 'in-sync' | 'not-applicable';
};

export async function syncAgentConfig(params: {
  workspaceFs: PluginFs;
  /** Null for a provider with no repository definitions (Codex, OpenCode). */
  repoAgents: IRepoAgentsBehavior | null;
  /** The agent's name, which is both its config-file key and its definition stem. */
  name: string;
  /** The agent's description, which the definition carries in its frontmatter. */
  description: string;
}): Promise<AgentConfigSyncResult> {
  const { workspaceFs, repoAgents, name, description } = params;

  const config = (await readAgentConfigFile(workspaceFs, name)) ?? {};
  if (!repoAgents) return { config, action: 'not-applicable' };

  const definitionPath = repoAgents.definitionPath(name);
  const generated = repoAgents.renderDefinition(
    definitionAttributes({ config, name, description })
  );
  const current = await workspaceFs.read(definitionPath);

  const action = decideArtifactSync({
    current,
    generated,
    lastRendered: config.rendered?.[definitionPath],
  });

  if (action === 'in-sync') return { config, action };

  if (action === 'adopt') {
    const adopted = await adoptDefinition({ workspaceFs, repoAgents, name, config });
    return { config: adopted, action: 'adopted' };
  }

  await workspaceFs.write(definitionPath, generated);
  const written: AgentConfigFile = {
    ...config,
    rendered: { ...config.rendered, [definitionPath]: fingerprintArtifact(generated) },
  };
  await writeAgentConfigFile(workspaceFs, name, written);
  return { config: written, action: 'written' };
}

/**
 * Take a hand-edited definition as the new truth: read it back into the config,
 * then regenerate so the two agree again and the fingerprint matches.
 *
 * Regenerating rather than leaving the file alone matters — the definition may
 * hold things the config cannot express (frontmatter this app does not model),
 * and writing the round-tripped version is what makes the next comparison
 * meaningful instead of reporting a hand edit forever.
 */
async function adoptDefinition(params: {
  workspaceFs: PluginFs;
  repoAgents: IRepoAgentsBehavior;
  name: string;
  config: AgentConfigFile;
}): Promise<AgentConfigFile> {
  const { workspaceFs, repoAgents, name, config } = params;

  const attributes = await repoAgents.readDefinition(workspaceFs, name);
  if (attributes === null) {
    throw new Error(`Agent ${name} has a definition that could not be read back.`);
  }

  const { name: _name, description, instructions, ...settings } = attributes;
  const adopted: AgentConfigFile = {
    ...config,
    instructions: typeof instructions === 'string' ? instructions : '',
    settings,
  };

  const definitionPath = repoAgents.definitionPath(name);
  const generated = repoAgents.renderDefinition(
    definitionAttributes({
      config: adopted,
      name,
      description: typeof description === 'string' ? description : '',
    })
  );
  await workspaceFs.write(definitionPath, generated);

  const result: AgentConfigFile = {
    ...adopted,
    rendered: { ...config.rendered, [definitionPath]: fingerprintArtifact(generated) },
  };
  await writeAgentConfigFile(workspaceFs, name, result);
  return result;
}

/**
 * The attribute map a provider renders from: the agent's settings, plus the
 * three things that are the agent's own rather than a setting.
 *
 * `instructions` is passed under that name for every provider — each renders it
 * into whatever mechanism it has, so the key is canonical here and provider
 * -specific only inside the provider.
 */
export function definitionAttributes(params: {
  config: AgentConfigFile;
  name: string;
  description: string;
}): RepoAgentAttributes {
  return {
    ...params.config.settings,
    name: params.name,
    description: params.description,
    instructions: params.config.instructions ?? '',
  };
}
