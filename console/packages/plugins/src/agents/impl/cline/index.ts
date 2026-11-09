import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'cline',
    name: 'Cline',
    description:
      'Open-source coding agent CLI that runs on Cline or on the model provider of your choice, over ACP.',
    websiteUrl: 'https://docs.cline.bot/usage/acp',
    cliLabel: 'Cline CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: npmDependency({
      id: 'cline',
      package: 'cline',
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
      throw new Error('Cline runs through the ACP session host.');
    },
  },
});
