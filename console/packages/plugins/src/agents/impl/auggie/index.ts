import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'auggie',
    name: 'Auggie',
    description: 'Auggie coding agent using the Agent Client Protocol (ACP).',
    websiteUrl: 'https://augmentcode.com/',
    cliLabel: 'Auggie CLI',
  },
  {
    autoApprove: {
      kind: 'none',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: npmDependency({
      id: 'auggie',
      package: '@augmentcode/auggie',
      binaryNames: ['auggie'],
      versionSuffix: 'prerelease',
    }),
    mcp: {
      kind: 'none',
    },
    models: {
      kind: 'none',
    },
    plugins: {
      kind: 'none',
    },
    prompt: {
      kind: 'none',
    },
    sessions: {
      kind: 'resumable',
    },
    repoAgents: {
      kind: 'none',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  prompt: {
    buildCommand: () => {
      throw new Error('Auggie runs through the ACP session host.');
    },
  },
});
