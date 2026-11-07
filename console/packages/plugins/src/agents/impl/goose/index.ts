import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

/**
 * Goose's install script, run without its final `goose configure`: that waits
 * for answers the installer cannot give.
 */
export const GOOSE_INSTALL_UNIX =
  'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash';

export const plugin = definePlugin(
  {
    id: 'goose',
    name: 'Goose',
    description: 'Goose over ACP, on whichever model provider you configure with goose configure.',
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
      installDocs: 'https://goose-docs.ai/docs/getting-started/installation',
      installCommands: {
        macos: [{ method: 'curl', command: GOOSE_INSTALL_UNIX, recommended: true }],
        linux: [{ method: 'curl', command: GOOSE_INSTALL_UNIX, recommended: true }],
      },
      updates: {
        kind: 'supported',
        releaseSource: {
          kind: 'none',
        },
        update: {
          kind: 'cli',
          args: ['update'],
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
