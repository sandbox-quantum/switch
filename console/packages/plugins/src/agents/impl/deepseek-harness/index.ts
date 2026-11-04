import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'deepseek-harness',
    name: 'DeepSeek Harness',
    description: 'DeepSeek Harness developer preview over ACP, with tools and persistent sessions.',
    websiteUrl: 'https://github.com/deepseek-ai/deepseek-harness',
  },
  {
    autoApprove: { kind: 'supported' },
    effort: { kind: 'none' },
    hostDependency: npmDependency({
      id: 'deepseek-harness',
      package: '@deepseek-ai/dsh',
      binaryNames: ['dsh'],
    }),
    mcp: { kind: 'none' },
    models: { kind: 'none' },
    plugins: { kind: 'none' },
    prompt: { kind: 'none' },
    sessions: { kind: 'resumable' },
    repoAgents: { kind: 'none' },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  prompt: {
    buildCommand: () => {
      throw new Error('DeepSeek Harness runs through the ACP session host.');
    },
  },
});
