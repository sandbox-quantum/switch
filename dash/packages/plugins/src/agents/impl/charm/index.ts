import { definePlugin, registerPluginBehavior } from '@switchdash/core/agents/plugins';
import { buildStandardCommand, npmDependency } from '@switchdash/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'charm',
    name: 'Charm',
    description: 'Charm Crush agent CLI providing terminal-first AI assistance for coding tasks.',
    websiteUrl: 'https://github.com/charmbracelet/crush',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hooks: {
      kind: 'none',
    },
    hostDependency: npmDependency({
      id: 'charm',
      package: '@charmland/crush',
      binaryNames: ['crush'],
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
      kind: 'argv',
      flag: '',
    },
    sessions: {
      kind: 'stateless',
    },
    repoAgents: { kind: 'none' },
    switchSetup: { kind: 'none' },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag: '--yolo',
      }),
  },
});
