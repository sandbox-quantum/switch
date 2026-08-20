import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { buildStandardCommand } from '@switch-console/core/agents/plugins/helpers';
import { buildGrokHookConfig } from './hooks';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'grok',
    name: 'Grok',
    description:
      "xAI's Grok CLI for terminal-first coding sessions with plans, subagents, and parallel work.",
    websiteUrl: 'https://x.ai/cli',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hooks: {
      kind: 'config',
      scope: 'global',
      supportedEvents: ['notification', 'stop', 'session', 'start'],
      reportsSessionStart: false,
    },
    hostDependency: {
      id: 'grok',
      binaryNames: ['grok'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: 'curl -fsSL https://x.ai/cli/install.sh | bash',
          },
        ],
        linux: [
          {
            method: 'curl',
            command: 'curl -fsSL https://x.ai/cli/install.sh | bash',
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
      flag: '',
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
        autoApproveFlag: '--always-approve',
        initialPromptFlag: '',
        resumeFlag: '-r',
        sessionIdFlag: '-r',
        sessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: '-r',
      }),
  },
  hooks: buildGrokHookConfig(),
});
