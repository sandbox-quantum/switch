import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    description:
      'GitHub Copilot CLI agent provider with ACP support for native approvals and sessions.',
    websiteUrl: 'https://github.com/features/copilot',
    cliLabel: 'GitHub Copilot CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'copilot',
      binaryNames: ['copilot', 'github-copilot-cli'],
      installCommands: {
        macos: [
          {
            method: 'homebrew',
            command: 'brew install --cask copilot-cli',
          },
          {
            method: 'npm',
            command: 'npm install -g @github/copilot',
          },
        ],
        linux: [
          {
            method: 'homebrew',
            command: 'brew install --cask copilot-cli',
          },
          {
            method: 'npm',
            command: 'npm install -g @github/copilot',
          },
        ],
        windows: [
          {
            method: 'winget',
            command: 'winget install GitHub.Copilot',
          },
          {
            method: 'npm',
            command: 'npm install -g @github/copilot',
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
      throw new Error('GitHub Copilot runs through the ACP session host.');
    },
  },
});
