import z from 'zod';
import { hostDependencyCapability } from '../../host-dependencies/capability';
import { createPluginFramework } from '../../lib/plugins/framework';
import { iconAsset } from './assets/icon';
import { autoApproveCapability } from './capabilities/auto-approve';
import { effortCapability } from './capabilities/effort';
import { hooksCapability } from './capabilities/hooks';
import { mcpCapability } from './capabilities/mcp';
import { modelsCapability } from './capabilities/models';
import { pluginsCapability } from './capabilities/plugins';
import { promptCapability } from './capabilities/prompt';
import { repoAgentsCapability } from './capabilities/repo-agents';
import { sessionsCapability } from './capabilities/sessions';
import { switchSetupCapability } from './capabilities/switch-setup';

export const PLUGIN_CAPABILITIES = {
  autoApprove: autoApproveCapability,
  effort: effortCapability,
  hooks: hooksCapability,
  hostDependency: hostDependencyCapability,
  mcp: mcpCapability,
  models: modelsCapability,
  plugins: pluginsCapability,
  prompt: promptCapability,
  sessions: sessionsCapability,
  repoAgents: repoAgentsCapability,
  switchSetup: switchSetupCapability,
} as const;

export type Capabilities = typeof PLUGIN_CAPABILITIES;

export const PLUGIN_ASSETS = {
  icon: iconAsset,
} as const;

export type Assets = typeof PLUGIN_ASSETS;

const metadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  websiteUrl: z.string(),
  compatibleVersions: z.string().optional(),
});

export type CLIAgentPluginMetadata = z.infer<typeof metadataSchema>;

export const { definePlugin, registerPluginBehavior } = createPluginFramework(
  PLUGIN_CAPABILITIES,
  metadataSchema,
  PLUGIN_ASSETS
);

export type CLIAgentPluginDefinition = ReturnType<typeof definePlugin>;
export type CLIAgentPluginProvider = ReturnType<typeof registerPluginBehavior>;

export type { AgentIconAsset, AgentIconVariant } from './assets/icon';

// Convenience re-exports for impl packages
export type { AgentCommand, CommandContext } from './capabilities/prompt';
export type {
  CanonicalHookEvent,
  HookCommand,
  HookCommandOptions,
  HookEvent,
  HookRegistration,
  NotificationType,
} from './capabilities/hooks-types';
export type { PluginFs } from '../runtime/fs';
// Capability behavior interfaces — needed for dts portability
export type { IHostDependencyBehavior } from '../../host-dependencies/capability';
export type { IHooksBehavior } from './capabilities/hooks';
export type {
  IMcpBehavior,
  LaunchProfileHostExec,
  LaunchProfileModel,
  McpServerRegistration,
  SwitchLaunchProfile,
  SwitchLaunchProfileFile,
  SwitchLaunchSpecialization,
} from './capabilities/mcp';
export {
  LAUNCH_PROFILE_HOME_PLACEHOLDER,
  resolveLaunchProfileEnv,
  resolveLaunchProfileHome,
} from './capabilities/mcp';
export type { IPlugins, PluginScope } from './capabilities/plugins';
export type { ISessionsBehavior } from './capabilities/sessions';
export {
  RECOGNISED_SWITCH_CONNECTOR_TOOL_RULES,
  SWITCH_AGENT_SETTINGS_DIR,
  SWITCH_CONNECTOR_TOOL_RULES,
} from './capabilities/repo-agents';
export type {
  IRepoAgentsBehavior,
  LocalRepoAgent,
  RepoAgentAttributes,
  RepoAgentAttributeValue,
  RepoAgentDefinition,
  RepoAgentField,
  RepoAgentFieldCatalogue,
  RepoAgentFieldOption,
  RepoAgentFieldType,
  RepoAgentsDescriptor,
} from './capabilities/repo-agents';
export type {
  ISwitchSetupBehavior,
  ISwitchSetupFilesBehavior,
  SwitchSetupCliDialect,
  SwitchSetupDescriptor,
} from './capabilities/switch-setup';
export { SWITCH_SETUP_CLI_DIALECTS } from './capabilities/switch-setup';

// Typed registry factory
export { createPluginRegistry } from '../../lib/plugins/registry';
