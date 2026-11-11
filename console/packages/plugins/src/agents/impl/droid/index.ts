import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const DROID_INSTALL_UNIX = 'curl -fsSL https://app.factory.ai/cli | sh';
export const DROID_INSTALL_WINDOWS =
  'powershell -ExecutionPolicy ByPass -c "irm https://app.factory.ai/cli.ps1 | iex"';

export const plugin = definePlugin(
  {
    id: 'droid',
    name: 'Factory Droid',
    description:
      "Factory's Droid agent CLI over ACP, with its autonomy levels mapped to Switch's runtime modes.",
    websiteUrl: 'https://docs.factory.com',
    cliLabel: 'Droid CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'droid',
      binaryNames: ['droid'],
      installDocs: 'https://docs.factory.com/cli/getting-started/quickstart',
      installCommands: {
        macos: [
          { method: 'curl', command: DROID_INSTALL_UNIX, recommended: true },
          { method: 'homebrew', command: 'brew install --cask droid' },
        ],
        linux: [{ method: 'curl', command: DROID_INSTALL_UNIX, recommended: true }],
        windows: [
          {
            method: 'powershell',
            command: DROID_INSTALL_WINDOWS,
            recommended: true,
          },
        ],
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

export function droidUpdateCommand(binaryPath: string): { command: string; args: string[] } {
  return { command: binaryPath, args: ['update'] };
}

export const provider = registerPluginBehavior(plugin, {
  hostDependency: { buildUpdateCommand: droidUpdateCommand },
  prompt: {
    buildCommand: () => {
      throw new Error('Factory Droid runs through the ACP session host.');
    },
  },
});
