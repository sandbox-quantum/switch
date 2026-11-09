import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { homebrewOption, npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'qwen',
    name: 'Qwen Code',
    description: "Alibaba's open-source coding agent, for Qwen and other OpenAI-compatible models.",
    websiteUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/overview',
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
      binaryNames: ['qwen'],
      extraOptions: { macos: [homebrewOption({ formula: 'qwen-code', recommended: false })] },
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
