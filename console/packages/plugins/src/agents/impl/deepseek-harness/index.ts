import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'deepseek-harness',
    name: 'DeepSeek Harness',
    description:
      "DeepSeek's open-source agent harness over its ACP server, with DeepSeek models and persistent, resumable sessions.",
    websiteUrl: 'https://github.com/deepseek-ai/deepseek-harness',
    cliLabel: 'DeepSeek Harness (dsh)',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    // `dsh --profile acp` serves ACP; the package needs Node 24.9 or later.
    hostDependency: npmDependency({
      id: 'deepseek-harness',
      package: '@deepseek-ai/dsh',
      binaryNames: ['dsh'],
      installDocs: 'https://github.com/deepseek-ai/deepseek-harness',
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
      throw new Error('DeepSeek Harness runs through the ACP session host.');
    },
  },
});
