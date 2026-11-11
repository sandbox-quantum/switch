import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const KIMI_INSTALL_CURL = 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash';
export const KIMI_INSTALL_NPM = 'npm install -g @moonshot-ai/kimi-code';
export const KIMI_INSTALL_WINDOWS = 'irm https://code.kimi.com/kimi-code/install.ps1 | iex';

export const plugin = definePlugin(
  {
    id: 'kimi',
    name: 'Kimi Code',
    description:
      "Moonshot AI's coding agent CLI; speaks ACP natively and signs in with a device code.",
    websiteUrl: 'https://www.kimi.com/code',
    cliLabel: 'Kimi Code CLI',
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
      id: 'kimi',
      binaryNames: ['kimi'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: KIMI_INSTALL_CURL,
          },
          {
            method: 'npm',
            command: KIMI_INSTALL_NPM,
          },
        ],
        linux: [
          {
            method: 'curl',
            command: KIMI_INSTALL_CURL,
          },
          {
            method: 'npm',
            command: KIMI_INSTALL_NPM,
          },
        ],
        windows: [
          {
            method: 'powershell',
            command: KIMI_INSTALL_WINDOWS,
          },
          {
            method: 'npm',
            command: KIMI_INSTALL_NPM,
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
      throw new Error('Kimi Code runs through the ACP session host.');
    },
  },
});
