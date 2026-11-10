import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'openhands',
    name: 'OpenHands',
    description: 'OpenHands AI software development agent with native ACP support.',
    websiteUrl: 'https://docs.openhands.dev',
    cliLabel: 'OpenHands CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'openhands',
      binaryNames: ['openhands'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: 'curl -fsSL https://install.openhands.dev/install.sh | sh',
          },
          {
            method: 'pip',
            command: 'pip install openhands-ai',
          },
        ],
        linux: [
          {
            method: 'curl',
            command: 'curl -fsSL https://install.openhands.dev/install.sh | sh',
          },
          {
            method: 'pip',
            command: 'pip install openhands-ai',
          },
        ],
        windows: [
          {
            method: 'powershell',
            command: 'irm https://install.openhands.dev/install.ps1 | iex',
          },
          {
            method: 'pip',
            command: 'pip install openhands-ai',
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
      throw new Error('OpenHands runs through the ACP session host.');
    },
  },
});
