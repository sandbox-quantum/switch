import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { homebrewOption, npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    description:
      "GitHub Copilot's agent CLI, on the models of your Copilot plan or on your own model provider.",
    websiteUrl: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server',
    cliLabel: 'Copilot CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: npmDependency({
      id: 'copilot',
      package: '@github/copilot',
      extraOptions: {
        macos: [homebrewOption({ formula: 'copilot-cli', cask: true })],
        linux: [homebrewOption({ formula: 'copilot-cli', cask: true })],
        windows: [
          {
            method: 'winget',
            command: 'winget install GitHub.Copilot',
            updateCommand: 'winget upgrade GitHub.Copilot',
            uninstallCommand: 'winget uninstall GitHub.Copilot',
          },
        ],
      },
    }),
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
      throw new Error('Copilot CLI runs through the ACP session host.');
    },
  },
});
