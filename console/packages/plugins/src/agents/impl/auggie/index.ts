import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'auggie',
    name: 'Auggie',
    description:
      "Augment Code's coding agent CLI over ACP, with Augment's models and persistent conversations.",
    websiteUrl: 'https://docs.augmentcode.com/cli/overview',
    cliLabel: 'Auggie (Augment Code CLI)',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: npmDependency({
      id: 'auggie',
      package: '@augmentcode/auggie',
      installDocs: 'https://docs.augmentcode.com/cli/setup-auggie/install-auggie-cli',
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
      throw new Error('Auggie runs through the ACP session host.');
    },
  },
});
