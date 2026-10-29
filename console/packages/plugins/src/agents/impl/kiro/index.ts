import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'kiro',
    name: 'Kiro',
    description:
      'Kiro CLI agent provider with native authentication, approvals and persistent conversations.',
    websiteUrl: 'https://kiro.dev/docs/cli/overview/',
    cliLabel: 'Kiro CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'kiro',
      binaryNames: ['kiro-cli', 'kiro'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: 'curl -fsSL https://kiro.dev/install.sh | bash',
          },
        ],
        linux: [
          {
            method: 'curl',
            command: 'curl -fsSL https://kiro.dev/install.sh | bash',
          },
        ],
        windows: [
          {
            method: 'powershell',
            command: 'irm https://kiro.dev/install.ps1 | iex',
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
      throw new Error('Kiro runs through the ACP session host.');
    },
  },
});

