import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'pi',
    name: 'Pi',
    description:
      'Pi, the open-source coding agent that works with many model providers, driven through its RPC mode.',
    websiteUrl: 'https://pi.dev',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: npmDependency({
      id: 'pi',
      package: '@earendil-works/pi-coding-agent',
      binaryNames: ['pi'],
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
      throw new Error('Pi runs through its RPC session host.');
    },
  },
});
