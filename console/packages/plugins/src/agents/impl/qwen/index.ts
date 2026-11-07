import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'qwen',
    name: 'Qwen Code',
    description:
      "Alibaba's Qwen Code CLI over ACP, on the model provider you sign it in to with /auth or an API key.",
    websiteUrl: 'https://qwenlm.github.io/qwen-code-docs/',
    cliLabel: 'Qwen Code CLI',
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
      installDocs: 'https://github.com/QwenLM/qwen-code#installation',
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
    repoAgents: { kind: 'none' },
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
