import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import {
  buildStandardCommand,
  cursorMcpAdapter,
} from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'aider',
    name: 'Aider',
    description:
      "Aider's terminal AI pair programming CLI; edits code in your local git repo with automatic git commits.",
    websiteUrl: 'https://aider.chat',
    cliLabel: 'Aider CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'aider',
      binaryNames: ['aider', 'aider-acp'],
      installCommands: {
        macos: [
          {
            method: 'pip',
            command: 'python -m pip install -U aider-install && aider-install',
          },
        ],
        linux: [
          {
            method: 'pip',
            command: 'python -m pip install -U aider-install && aider-install',
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
        autoApproveFlag: '--yes-always',
        initialPromptFlag: '--message',
        resumeFlag: '--restore-chat-history',
      }),
  },
  mcp: {
    ...cursorMcpAdapter(),
    launchProfileSettings: () => ({}),
  },
});
