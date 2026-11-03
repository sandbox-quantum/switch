import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const COPILOT_INSTALL_CURL = 'curl -fsSL https://gh.io/copilot-install | bash';
export const COPILOT_INSTALL_NPM = 'npm install -g @github/copilot';

export const plugin = definePlugin(
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    description:
      "GitHub's Copilot agent in the terminal; speaks ACP and signs in with GitHub, a token, or your own model provider.",
    websiteUrl: 'https://github.com/features/copilot',
    cliLabel: 'GitHub Copilot CLI',
    sessionStartMaySignIn: true,
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
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: COPILOT_INSTALL_CURL,
          },
          {
            method: 'npm',
            command: COPILOT_INSTALL_NPM,
          },
        ],
        linux: [
          {
            method: 'curl',
            command: COPILOT_INSTALL_CURL,
          },
          {
            method: 'npm',
            command: COPILOT_INSTALL_NPM,
          },
        ],
        windows: [
          {
            method: 'npm',
            command: COPILOT_INSTALL_NPM,
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
      throw new Error('GitHub Copilot CLI runs through the ACP session host.');
    },
  },
});
