import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

const KIMI_INSTALL_COMMAND = 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash';

export const plugin = definePlugin(
  {
    id: 'kimi',
    name: 'Kimi Code',
    description:
      "Moonshot AI's coding agent CLI, running Kimi models or any provider configured in it.",
    websiteUrl: 'https://moonshotai.github.io/kimi-code/en/',
    cliLabel: 'Kimi Code CLI',
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
          { method: 'curl', command: KIMI_INSTALL_COMMAND },
          { method: 'npm', command: 'npm install -g @moonshot-ai/kimi-code' },
        ],
        linux: [
          { method: 'curl', command: KIMI_INSTALL_COMMAND },
          { method: 'npm', command: 'npm install -g @moonshot-ai/kimi-code' },
        ],
        windows: [
          {
            method: 'powershell',
            command: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex',
          },
          { method: 'npm', command: 'npm install -g @moonshot-ai/kimi-code' },
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
