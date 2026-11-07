import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'qwen',
    name: 'Qwen Code',
    description:
      'Qwen Code CLI using the Agent Client Protocol (ACP) with persistent conversations.',
    websiteUrl: 'https://github.com/QwenLM/qwen-code',
    cliLabel: 'Qwen Code ACP',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: npmDependency({
      id: 'qwen',
      package: '@qwen-code/qwen-code',
      binaryNames: ['qwen'],
      installDocs: 'https://github.com/QwenLM/qwen-code',
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
      throw new Error('Qwen Code runs through the ACP session host.');
    },
  },
});
