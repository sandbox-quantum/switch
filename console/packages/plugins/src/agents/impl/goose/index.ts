import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

// CONFIGURE=false keeps the script from starting `goose configure`, which asks
// questions on the terminal; the person runs it as the sign-in command instead.
const GOOSE_INSTALL_COMMAND =
  'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash';

export const plugin = definePlugin(
  {
    id: 'goose',
    name: 'Goose',
    description:
      'Block’s open-source Goose agent over ACP, on the model provider you configure for it.',
    websiteUrl: 'https://goose-docs.ai/docs/guides/acp-clients',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'goose',
      binaryNames: ['goose'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: GOOSE_INSTALL_COMMAND,
          },
        ],
        linux: [
          {
            method: 'curl',
            command: GOOSE_INSTALL_COMMAND,
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
      throw new Error('Goose runs through the ACP session host.');
    },
  },
});
