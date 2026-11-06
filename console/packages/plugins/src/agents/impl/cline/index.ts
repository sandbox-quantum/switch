import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { buildStandardCommand } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'cline',
    name: 'Cline',
    description: "Cline's autonomous coding agent CLI speaking native ACP.",
    websiteUrl: 'https://docs.cline.bot',
    cliLabel: 'Cline CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'cline',
      binaryNames: ['cline'],
      installCommands: {
        macos: [
          {
            method: 'npm',
            command: 'npm install -g cline',
          },
        ],
        linux: [
          {
            method: 'npm',
            command: 'npm install -g cline',
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
        autoApproveFlag: '--auto-approve true',
        initialPromptFlag: '',
        resumeFlag: '--resume',
      }),
  },
});
