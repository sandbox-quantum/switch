import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { homebrewOption } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

// The script installs Goose's own build, which updates itself.
const GOOSE_UPDATE = 'goose update';
const GOOSE_INSTALL_SCRIPT =
  'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash';

export const plugin = definePlugin(
  {
    id: 'goose',
    name: 'Goose',
    description:
      'An open-source agent with native ACP, model-provider choice and persistent conversations.',
    websiteUrl: 'https://goose-docs.ai/',
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
        // CONFIGURE=false: the installers otherwise run `goose configure`,
        // which waits for answers no one can type here.
        windows: [
          {
            method: 'powershell',
            command:
              "$env:CONFIGURE = 'false'; Invoke-WebRequest -Uri https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1 -OutFile download_cli.ps1; .\\download_cli.ps1",
            updateCommand: GOOSE_UPDATE,
          },
        ],
        macos: [
          {
            method: 'curl',
            command: GOOSE_INSTALL_SCRIPT,
            updateCommand: GOOSE_UPDATE,
            recommended: true,
          },
          homebrewOption({ formula: 'block-goose-cli' }),
        ],
        linux: [
          {
            method: 'curl',
            command: GOOSE_INSTALL_SCRIPT,
            updateCommand: GOOSE_UPDATE,
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
