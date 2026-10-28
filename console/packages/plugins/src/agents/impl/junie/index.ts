import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'junie',
    name: 'Junie',
    description:
      "JetBrains' AI coding agent with native ACP support, approvals, and resumable sessions.",
    websiteUrl: 'https://www.jetbrains.com/junie/',
    cliLabel: 'Junie CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'junie',
      binaryNames: ['junie'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: 'curl -fsSL https://junie.jetbrains.com/install.sh | bash',
          },
        ],
        linux: [
          {
            method: 'curl',
            command: 'curl -fsSL https://junie.jetbrains.com/install.sh | bash',
          },
        ],
        windows: [
          {
            method: 'powershell',
            command:
              'powershell -NoProfile -ExecutionPolicy Bypass -Command "iex (irm \'https://junie.jetbrains.com/install.ps1\')"',
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
      throw new Error('Junie runs through the ACP session host.');
    },
  },
});
