import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'grok-build',
    name: 'Grok Build',
    description:
      "xAI's Grok Build agent CLI; a terminal coding agent that speaks ACP with API key or browser authentication.",
    websiteUrl: 'https://x.ai/build',
    cliLabel: 'Grok Build CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: npmDependency({
      id: 'grok-build',
      package: '@xai-official/grok',
      binaryNames: ['grok'],
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
      throw new Error('Grok Build runs through the ACP session host.');
    },
  },
});
