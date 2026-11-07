import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { homebrewOption } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

// CONFIGURE=false: the installer would otherwise start `goose configure`,
// which Console shows as the separate sign-in step.
const GOOSE_INSTALL_COMMAND =
  'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash';

export const plugin = definePlugin(
  {
    id: 'goose',
    name: 'Goose',
    description:
      'The open-source goose agent over ACP, on the model provider you configure, with approvals and persistent conversations.',
    websiteUrl: 'https://goose-docs.ai/docs/gdk/acp/',
    cliLabel: 'Goose CLI',
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
          { method: 'curl', command: GOOSE_INSTALL_COMMAND, recommended: true },
          homebrewOption({ formula: 'block-goose-cli' }),
        ],
        linux: [{ method: 'curl', command: GOOSE_INSTALL_COMMAND }],
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
