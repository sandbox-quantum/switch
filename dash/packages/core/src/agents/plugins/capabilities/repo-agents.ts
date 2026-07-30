import z from 'zod';
import { definePluginCapability } from '../../../lib/plugins/capability';
import type { PluginFs } from '../../runtime/fs';

/**
 * A repository-defined agent the provider can run, discovered locally from its
 * on-disk credentials/definition files (before gateway reconciliation).
 */
export type LocalRepoAgent = {
  name: string;
  description: string | null;
  model: string | null;
  switchAgentId: string | null;
  apiEndpoint: string | null;
};

/**
 * An agent definition discovered in a working directory, with whether it can join
 * Switch (`eligible`) and whether it already carries Switch credentials
 * (`registered`). Used by the Add Agent modal to offer onboarding a directory's
 * existing agents.
 */
export type RepoAgentDefinition = {
  name: string;
  description: string | null;
  model: string | null;
  eligible: boolean;
  registered: boolean;
};

/**
 * The MCP permission rules that keep a Switch agent connected to the platform:
 * the connector's two MCP servers. Used both as `tools` allowlist entries (so an
 * agent that restricts its tools stays Switch-capable) and as `permissions.allow`
 * entries (so the connector's tools are auto-approved — "don't ask"). Authored
 * once here so every provider's onboarding path agrees.
 */
export const SWITCH_CONNECTOR_TOOL_RULES = [
  'mcp__plugin_switch-connector_switch',
  'mcp__plugin_switch-connector_switch-channel',
] as const;

/**
 * Provider-neutral directory (relative to a location's working directory) for
 * per-agent Switch credentials. One `<name>.json` per agent, keeping the store
 * out of any single provider's config tree (CHOO-1440). POSIX separator so it is
 * stable across local and SFTP filesystems.
 */
export const SWITCH_AGENT_SETTINGS_DIR = '.switch/agents';

/** A renderable input type for an agent attribute field. */
export type RepoAgentFieldType = 'text' | 'textarea' | 'select' | 'list' | 'number' | 'boolean';

export type RepoAgentFieldOption = { value: string; label: string };

/**
 * One editable attribute of an agent, declared by the agent provider. The
 * renderer builds the create/edit form from these descriptors, so the set of
 * attributes — and how they are presented — is provider-specific. `key` is the
 * attribute name in the {@link RepoAgentAttributes} map the provider serializes.
 */
export type RepoAgentField = {
  key: string;
  label: string;
  type: RepoAgentFieldType;
  required?: boolean;
  /** Fixed once the agent exists (e.g. the name, which is its identity). */
  immutableOnEdit?: boolean;
  placeholder?: string;
  help?: string;
  /** Choices for `select`. Include an empty-value option to mean "unset". */
  options?: RepoAgentFieldOption[];
};

/** A single attribute value; shape depends on the field's `type`. */
export type RepoAgentAttributeValue = string | string[] | number | boolean | null;

/** An agent's attributes, keyed by {@link RepoAgentField.key}. Always carries
 * `name` and `description`; the rest are provider-defined. */
export type RepoAgentAttributes = Record<string, RepoAgentAttributeValue>;

/**
 * How an agent provider creates, runs, and credentials the named agents defined
 * in a working directory. Switchdash has no notion of "subagents" — it just asks
 * a provider to create and run an agent with a given name in a directory, and to
 * support several such agents in one directory. HOW the provider does that (Claude
 * Code uses subagents; another provider might use something else) is entirely the
 * provider's business and lives behind this behavior; the main process supplies a
 * `PluginFs` for the IO and owns the provider-neutral gateway reconciliation.
 *
 * `workspaceFs` is rooted at the agent's working directory; `homeFs` at the user's
 * home — definitions may resolve in either scope.
 */
export type IRepoAgentsBehavior = {
  /** Runnable agents, from the working dir's on-disk credentials + definitions. */
  discoverLocal(workspaceFs: PluginFs, homeFs: PluginFs): Promise<LocalRepoAgent[]>;
  /** Agent definitions in the working dir, for onboarding (project scope). */
  discoverDefinitions(workspaceFs: PluginFs): Promise<RepoAgentDefinition[]>;
  /** Provider-specific CLI args that run the CLI as the named agent. Pure — the
   * caller passes them to `buildCommand` as `agentArgs` (not user extra args). */
  launchArgs(workingDir: string, agentName: string): string[];
  /** The named agent's Switch credentials as env vars, for the launched session. */
  readLaunchEnv(workspaceFs: PluginFs, agentName: string): Promise<Record<string, string>>;
  /** The attribute fields this provider supports, in display order. Drives the
   * create/edit form; the first two are always `name` and `description`. */
  attributeFields(): RepoAgentField[];
  /** Create or overwrite a named agent's on-disk definition from its attributes
   * (workspace scope). `attributes.name` selects the agent. */
  writeDefinition(workspaceFs: PluginFs, attributes: RepoAgentAttributes): Promise<void>;
  /** The current attribute values for an existing agent definition, keyed to
   * {@link attributeFields}, or null if no definition exists. */
  readDefinition(workspaceFs: PluginFs, name: string): Promise<RepoAgentAttributes | null>;
  /** Remove a named agent's provider-specific files — its definition and any
   * legacy per-agent settings (workspace scope). The provider-neutral Switch
   * credentials are not this hook's to remove: they are written for every
   * provider, so they are torn down by the caller for every provider too. */
  removeLocal(workspaceFs: PluginFs, name: string): Promise<void>;
};

/**
 * kind: 'definitions' — the provider supports repository-defined named agents
 *   (e.g. Claude Code implements this with its subagents: `.md` definitions under
 *   `definitionsDirRelative`, launched with `--agent`/`--settings`).
 * kind: 'none' — the provider has no repository-agent concept; the UI surfaces
 *   nothing beyond a single default agent.
 */
export const repoAgentsCapability = definePluginCapability<IRepoAgentsBehavior>()(
  'repo-agents',
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('definitions'),
      /** Credentials dir, relative to the working dir, e.g. '.claude/switch-subagents'. */
      dirRelative: z.string(),
      /** Credentials filename suffix, e.g. '.settings.json'. */
      settingsSuffix: z.string(),
      /** Definitions dir, relative to the working dir, e.g. '.claude/agents'. */
      definitionsDirRelative: z.string(),
    }),
    z.object({ kind: z.literal('none') }),
  ])
);

export type RepoAgentsDescriptor = (typeof repoAgentsCapability)['_descriptor'];
