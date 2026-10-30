import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'goose',
    name: 'Goose',
    description:
      'Open-source, model-agnostic AI agent from Block and the Linux Foundation Agentic AI Foundation.',
    websiteUrl: 'https://goose-docs.ai',
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
          {
            method: 'homebrew',
            command: 'brew install block-goose-cli',
          },
          {
            method: 'curl',
            command:
              'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash',
          },
        ],
        linux: [
          {
            method: 'curl',
            command:
              'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash',
          },
        ],
        windows: [
          {
            method: 'powershell',
            command:
              'Invoke-WebRequest -Uri "https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1" -OutFile "download_cli.ps1"; .\\download_cli.ps1',
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
