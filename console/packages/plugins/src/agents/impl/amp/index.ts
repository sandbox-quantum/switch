import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import {
  buildStandardCommand,
  cursorMcpAdapter,
} from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'amp',
    name: 'Amp',
    description:
      "Sourcegraph's Amp coding agent; deep reasoning and codebase navigation from the command line.",
    websiteUrl: 'https://ampcode.com/docs',
    cliLabel: 'Amp CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'amp',
      binaryNames: ['amp', 'amp-acp'],
      installCommands: {
        macos: [
          {
            method: 'npm',
            command: 'npm install -g @ampcode/cli',
          },
        ],
        linux: [
          {
            method: 'npm',
            command: 'npm install -g @ampcode/cli',
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
        autoApproveFlag: '--yes',
        initialPromptFlag: '',
        resumeFlag: '--resume',
      }),
  },
  mcp: {
    ...cursorMcpAdapter(),
    launchProfileSettings: () => ({}),
  },
});
