import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { buildStandardCommand } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'antigravity',
    name: 'Antigravity',
    description:
      'Google Antigravity CLI for terminal-first agent sessions with shared Antigravity settings and conversation history.',
    websiteUrl: 'https://antigravity.google/docs/cli-overview',
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
    hostDependency: {
      id: 'antigravity',
      binaryNames: ['agy', 'antigravity'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
          },
        ],
        linux: [
          {
            method: 'curl',
            command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
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
      flag: '-i',
    },
    sessions: {
      kind: 'resumable',
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
        autoApproveFlag: '--dangerously-skip-permissions',
        initialPromptFlag: '-i',
        sessionIdFlag: '--conversation=',
        sessionIdAlways: true,
      }),
  },
});
