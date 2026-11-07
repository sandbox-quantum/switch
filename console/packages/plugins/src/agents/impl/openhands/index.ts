import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

const OPENHANDS_INSTALL_COMMAND = 'curl -fsSL https://install.openhands.dev/install.sh | sh';

export const plugin = definePlugin(
  {
    id: 'openhands',
    name: 'OpenHands',
    description:
      'OpenHands CLI over ACP, with its own confirmation modes, persistent conversations and the model from its own settings.',
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
            command: OPENHANDS_INSTALL_COMMAND,
          },
        ],
        linux: [
          {
            method: 'curl',
            command: OPENHANDS_INSTALL_COMMAND,
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
