import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    description:
      "GitHub's Copilot coding agent CLI over ACP, routing between several model vendors on a Copilot plan or your own key.",
    websiteUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli',
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
      binaryNames: ['copilot'],
      installDocs:
        'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
      installCommands: {
        macos: [
          { method: 'homebrew', command: 'brew install copilot-cli', recommended: true },
          { method: 'npm', command: 'npm install -g @github/copilot' },
        ],
        linux: [
          { method: 'npm', command: 'npm install -g @github/copilot', recommended: true },
          { method: 'homebrew', command: 'brew install copilot-cli' },
        ],
        windows: [
          { method: 'winget', command: 'winget install GitHub.Copilot', recommended: true },
          { method: 'npm', command: 'npm install -g @github/copilot' },
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
      throw new Error('GitHub Copilot CLI runs through the ACP session host.');
    },
  },
});
