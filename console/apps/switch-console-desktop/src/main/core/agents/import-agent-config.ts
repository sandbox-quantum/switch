import type {
  IRepoAgentsBehavior,
  PluginFs,
  RepoAgentAttributes,
  RepoAgentField,
} from '@switch-console/core/agents/plugins';
import { log } from '@main/lib/logger';
import {
  attributesFromProviderConfig,
  type AgentProviderConfig,
} from '@shared/core/agents/agent-provider-config';
import type { AgentConfigFile } from './agent-config-file';
import {
  decideArtifactSync,
  fingerprintArtifact,
  readAgentConfigFile,
  serialiseAgentConfigFile,
  writeAgentConfigFile,
} from './agent-config-file';
import { agentConfigRelativePath } from './switch-settings-paths';

/**
 * Give an existing agent its config file, taking over whatever an earlier
 * version of this app kept elsewhere.
 *
 * Before the config file was the only record, a Claude Code agent's
 * instructions, settings and description lived in its definition
 * (`.claude/agents/<name>.md`), and a hand edit there was read back into the
 * config on every read. That file is no longer read at launch, so this brings
 * it over:
 * - an edit made there by hand since this app last generated it is taken over,
 *   as the old read-back would have;
 * - the description comes from there, since that is the only place it was kept;
 * - a definition with no frontmatter (empty, or cut off mid-write) is not
 *   taken over, since there is nothing in it to tell an edit from damage;
 * - a setting whose value this app would not offer (a hand-typed `effort:
 *   High`) is left out rather than carried into every launch.
 *
 * The definition file is left where it is, and recorded as accounted for (see
 * {@link acknowledgeDefinition}).
 *
 * A provider without definitions kept its settings on the agent row, which
 * seeds a config file only when there is none.
 *
 * Returns whether the config file was written. Throws when an existing config
 * file cannot be parsed — writing over it would lose what it holds.
 */
export async function importAgentConfig(params: {
  workspaceFs: PluginFs;
  /** Null for a provider with no repository definitions. */
  repoAgents: IRepoAgentsBehavior | null;
  name: string;
  providerConfig: AgentProviderConfig | null;
}): Promise<boolean> {
  const { workspaceFs, repoAgents, name, providerConfig } = params;
  const existing = await readAgentConfigFile(workspaceFs, name);

  const imported = repoAgents
    ? await importDefinition({ workspaceFs, repoAgents, name, existing })
    : (existing ?? fromProviderConfig(providerConfig));

  if (existing && serialiseAgentConfigFile(imported) === serialiseAgentConfigFile(existing)) {
    return false;
  }
  await writeAgentConfigFile(workspaceFs, name, imported);
  return true;
}

/**
 * Record a provider definition left on disk as already reflected in the config.
 *
 * The definition is no longer written, so it goes stale. An older Switch
 * Console sharing the working directory still reconciles the two on every read,
 * and would take a stale definition it has no fingerprint for as a hand edit
 * and copy it over the config. With its fingerprint recorded, that Console sees
 * a definition it generated itself and regenerates it from the config instead.
 */
export async function acknowledgeDefinition(params: {
  workspaceFs: PluginFs;
  repoAgents: IRepoAgentsBehavior | null;
  name: string;
  config: AgentConfigFile;
}): Promise<AgentConfigFile> {
  const { workspaceFs, repoAgents, name, config } = params;
  if (!repoAgents) return config;
  const definitionPath = repoAgents.definitionPath(name);
  const current = await workspaceFs.read(definitionPath);
  if (current === null) return config;
  return {
    ...config,
    rendered: { ...config.rendered, [definitionPath]: fingerprintArtifact(current) },
  };
}

async function importDefinition(params: {
  workspaceFs: PluginFs;
  repoAgents: IRepoAgentsBehavior;
  name: string;
  existing: AgentConfigFile | null;
}): Promise<AgentConfigFile> {
  const { workspaceFs, repoAgents, name, existing } = params;
  const config = existing ?? {};
  const acknowledge = (next: AgentConfigFile) =>
    acknowledgeDefinition({ workspaceFs, repoAgents, name, config: next });

  const definitionPath = repoAgents.definitionPath(name);
  const current = await workspaceFs.read(definitionPath);
  if (current === null) return config;

  const attributes = await repoAgents.readDefinition(workspaceFs, name);
  if (attributes === null || !hasFrontmatter(current)) {
    log.warn('importAgentConfig: agent definition has no frontmatter; not importing it', {
      name,
      definitionPath,
    });
    return acknowledge(config);
  }

  const { name: _name, description, instructions, ...settings } = attributes;
  const withDescription: AgentConfigFile = {
    ...config,
    description: typeof description === 'string' ? description : '',
  };

  const action = decideArtifactSync({
    current,
    generated: repoAgents.renderDefinition({
      ...config.settings,
      name,
      description: withDescription.description ?? '',
      instructions: config.instructions ?? '',
    }),
    lastRendered: config.rendered?.[definitionPath],
  });
  if (action !== 'adopt') return acknowledge(withDescription);

  return acknowledge({
    ...withDescription,
    instructions: typeof instructions === 'string' ? instructions : '',
    settings: offeredSettings(name, settings, repoAgents.attributeFields()),
  });
}

/**
 * The settings this app would let someone choose: a choice-list value that is
 * one of its choices, a count that is a positive whole number. Anything else in
 * a hand-edited definition is dropped, and said so.
 */
function offeredSettings(
  name: string,
  settings: RepoAgentAttributes,
  fields: RepoAgentField[]
): RepoAgentAttributes {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const kept: RepoAgentAttributes = {};
  for (const [key, value] of Object.entries(settings)) {
    const field = byKey.get(key);
    const offered =
      field?.type === 'select'
        ? value === '' || (field.options ?? []).some((option) => option.value === value)
        : field?.type === 'number'
          ? value === null || (typeof value === 'number' && Number.isInteger(value) && value > 0)
          : true;
    if (offered) {
      kept[key] = value;
    } else {
      log.warn('importAgentConfig: dropping a setting this app would not offer', {
        name,
        configPath: agentConfigRelativePath(name),
        key,
        value,
      });
    }
  }
  return kept;
}

function hasFrontmatter(content: string): boolean {
  return /^\uFEFF?---\r?\n[\s\S]*?\r?\n---/.test(content);
}

function fromProviderConfig(providerConfig: AgentProviderConfig | null): AgentConfigFile {
  const { instructions, ...settings } = attributesFromProviderConfig(providerConfig);
  return {
    ...(typeof instructions === 'string' ? { instructions } : {}),
    settings,
  };
}
