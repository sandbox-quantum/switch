import z from 'zod';
import { definePluginCapability } from '../../../lib/plugins/capability';
import type { PluginFs } from '../../runtime/fs';

/**
 * A subagent the parent can launch, discovered locally from the parent's
 * credentials/definition files (before gateway reconciliation).
 */
export type LocalSubagent = {
  name: string;
  description: string | null;
  model: string | null;
  switchAgentId: string | null;
  apiEndpoint: string | null;
};

/**
 * A subagent definition discovered in the parent's working directory, with
 * whether it can join Switch (`eligible`) and whether it's already been brought
 * into Switch (`registered`). Used by the Add Agent modal to offer onboarding the
 * directory's subagents alongside the parent.
 */
export type SubagentDefinition = {
  name: string;
  description: string | null;
  model: string | null;
  eligible: boolean;
  registered: boolean;
};

/** Credentials written for a subagent so its sessions act under its own identity. */
export type SubagentCredentials = {
  subagentName: string;
  apiEndpoint: string;
  apiToken: string;
  agentId: string;
};

/**
 * The MCP permission rules that keep a Switch agent (or subagent) connected to
 * the platform: the connector's two MCP servers. Used both as `tools` allowlist
 * entries (so a subagent that restricts its tools stays Switch-capable) and as
 * `permissions.allow` entries (so the connector's tools are auto-approved —
 * "don't ask"). Authored once here so the parent-onboarding and subagent paths
 * agree.
 */
export const SWITCH_CONNECTOR_TOOL_RULES = [
  'mcp__plugin_switch-connector_switch',
  'mcp__plugin_switch-connector_switch-channel',
] as const;

/**
 * Provider-neutral directory (relative to a location's working directory) for
 * per-agent Switch credentials, replacing provider-specific layouts such as
 * Claude's `.claude/switch-subagents/`. One `<name>.json` per agent, keeping the
 * store out of any single provider's config tree (CHOO-1440). POSIX separator so
 * it is stable across local and SFTP filesystems.
 */
export const SWITCH_AGENT_SETTINGS_DIR = '.switch/agents';

/** A renderable input type for a subagent attribute field. */
export type SubagentFieldType = 'text' | 'textarea' | 'select' | 'list' | 'number' | 'boolean';

export type SubagentFieldOption = { value: string; label: string };

/**
 * One editable attribute of a subagent, declared by the agent type. The renderer
 * builds the create/edit form from these descriptors, so the set of attributes
 * — and how they are presented — is provider-specific. `key` is the attribute
 * name in the {@link SubagentAttributes} map the provider serializes.
 */
export type SubagentField = {
  key: string;
  label: string;
  type: SubagentFieldType;
  required?: boolean;
  /** Fixed once the subagent exists (e.g. the name, which is its identity). */
  immutableOnEdit?: boolean;
  placeholder?: string;
  help?: string;
  /** Choices for `select`. Include an empty-value option to mean "unset". */
  options?: SubagentFieldOption[];
};

/** A single attribute value; shape depends on the field's `type`. */
export type SubagentAttributeValue = string | string[] | number | boolean | null;

/** A subagent's attributes, keyed by {@link SubagentField.key}. Always carries
 * `name` and `description`; the rest are provider-defined. */
export type SubagentAttributes = Record<string, SubagentAttributeValue>;

/**
 * How an agent type discovers, launches, and credentials its subagents.
 *
 * Subagents are a per-provider feature: an agent that supports them spawns child
 * agents that run with their own Switch identity. The mechanism (file layout,
 * launch flags, credential injection) is provider-specific, so it lives behind
 * this behavior; the main process supplies a `PluginFs` for the IO and owns the
 * provider-neutral gateway reconciliation.
 *
 * `workspaceFs` is rooted at the agent's working directory; `homeFs` at the
 * user's home — definitions may resolve in either scope.
 */
export type ISubagentsBehavior = {
  /** Launchable subagents, from the parent's on-disk credentials + definitions. */
  discoverLocal(workspaceFs: PluginFs, homeFs: PluginFs): Promise<LocalSubagent[]>;
  /** Subagent definitions in the working dir, for onboarding (project scope). */
  discoverDefinitions(workspaceFs: PluginFs): Promise<SubagentDefinition[]>;
  /** Extra CLI args that launch a session as `subagentName`. Pure. */
  launchArgs(sessionPath: string, subagentName: string): string[];
  /** The subagent's Switch credentials as env vars, for the launched session. */
  readLaunchEnv(workspaceFs: PluginFs, subagentName: string): Promise<Record<string, string>>;
  /** Write a subagent's credentials so it is immediately launchable. */
  writeSettings(workspaceFs: PluginFs, credentials: SubagentCredentials): Promise<void>;
  /** The attribute fields this agent type supports, in display order. Drives the
   * create/edit form; the first two are always `name` and `description`. */
  attributeFields(): SubagentField[];
  /** Create or overwrite a subagent's on-disk definition from its attributes
   * (workspace scope). `attributes.name` selects the file. */
  writeDefinition(workspaceFs: PluginFs, attributes: SubagentAttributes): Promise<void>;
  /** The current attribute values for an existing definition, keyed to
   * {@link attributeFields}, or null if no definition exists. */
  readDefinition(workspaceFs: PluginFs, name: string): Promise<SubagentAttributes | null>;
  /** Remove a subagent's definition and credentials files (workspace scope). */
  removeLocal(workspaceFs: PluginFs, name: string): Promise<void>;
};

/**
 * kind: 'claude-agents' — Claude-Code-style subagents: `.md` definitions under
 *   `definitionsDirRelative` and per-subagent Switch credentials under
 *   `dirRelative/<name><settingsSuffix>`, launched with `--agent`/`--settings`.
 * kind: 'none' — the agent has no subagent concept; the UI surfaces nothing.
 */
export const subagentsCapability = definePluginCapability<ISubagentsBehavior>()(
  'subagents',
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('claude-agents'),
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

export type SubagentsDescriptor = (typeof subagentsCapability)['_descriptor'];
