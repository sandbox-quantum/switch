import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'droid',
    name: 'Factory Droid',
    description: "Factory's coding agent, running through native ACP.",
    websiteUrl: 'https://docs.factory.com/ide-integrations',
    cliLabel: 'Factory Droid CLI',
    sessionStartMaySignIn: true,
  },
  {
    autoApprove: { kind: 'supported' },
    effort: { kind: 'none' },
    hostDependency: {
      id: 'droid',
      binaryNames: ['droid'],
      installDocs: 'https://docs.factory.com/droid-cli/cli-reference',
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: 'curl -fsSL https://app.factory.ai/cli | sh',
            recommended: true,
          },
        ],
        linux: [
          {
            method: 'curl',
            command: 'curl -fsSL https://app.factory.ai/cli | sh',
            recommended: true,
          },
        ],
        windows: [
          {
            method: 'powershell',
            command:
              'powershell -ExecutionPolicy ByPass -c "irm https://app.factory.ai/cli/windows | iex"',
            recommended: true,
          },
        ],
      },
      updates: {
        kind: 'supported',
        releaseSource: { kind: 'none' },
        update: { kind: 'cli', args: ['update'] },
      },
    },
    mcp: { kind: 'none' },
    models: { kind: 'none' },
    plugins: { kind: 'none' },
    prompt: { kind: 'none' },
    sessions: { kind: 'resumable' },
    repoAgents: { kind: 'none' },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  prompt: {
    buildCommand: () => {
      throw new Error('Factory Droid runs through the ACP session host.');
    },
  },
});
