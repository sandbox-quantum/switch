import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'kiro',
    name: 'Kiro CLI',
    description: "AWS's agent CLI, on Kiro's own credit-based plans.",
    websiteUrl: 'https://kiro.dev/docs/cli/',
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
      binaryNames: ['kiro-cli'],
      installCommands: {
        macos: [{ method: 'curl', command: 'curl -fsSL https://cli.kiro.dev/install | bash' }],
        linux: [{ method: 'curl', command: 'curl -fsSL https://cli.kiro.dev/install | bash' }],
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
      throw new Error('Kiro CLI runs through the ACP session host.');
    },
  },
});
