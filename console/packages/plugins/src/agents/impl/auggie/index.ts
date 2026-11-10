import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { buildStandardCommand } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'auggie',
    name: 'Auggie',
    description: "Augment Code's context-engine coding agent CLI speaking native ACP.",
    websiteUrl: 'https://docs.augmentcode.com',
    cliLabel: 'Auggie CLI',
  },
  {
    autoApprove: {
      kind: 'none',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'auggie',
      binaryNames: ['auggie'],
      installCommands: {
        macos: [
          {
            method: 'npm',
            command: 'npm install -g @augmentcode/auggie',
          },
        ],
        linux: [
          {
            method: 'npm',
            command: 'npm install -g @augmentcode/auggie',
          },
        ],
      },
      updates: {
        kind: 'supported',
        releaseSource: {
          kind: 'none',
        },
        update: {
          kind: 'package-manager',
        },
      },
    },
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
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
      kind: 'resumable',
    },
    repoAgents: { kind: 'none' },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        initialPromptFlag: '',
        resumeFlag: '--resume',
      }),
  },
});
