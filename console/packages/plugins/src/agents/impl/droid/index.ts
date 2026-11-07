import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { homebrewOption } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'droid',
    name: 'Factory Droid',
    description: "Factory's coding agent for long autonomous runs over native ACP.",
    websiteUrl: 'https://docs.factory.ai/droid-exec/overview',
    cliLabel: 'Droid',
  },
  {
    autoApprove: { kind: 'supported' },
    effort: { kind: 'none' },
    hostDependency: {
      id: 'droid',
      binaryNames: ['droid'],
      installCommands: {
        macos: [
          homebrewOption({ formula: 'droid' }),
          { method: 'npm', command: 'npm install -g droid' },
          { method: 'curl', command: 'curl -fsSL https://app.factory.ai/cli | sh' },
        ],
        linux: [
          { method: 'npm', command: 'npm install -g droid' },
          { method: 'curl', command: 'curl -fsSL https://app.factory.ai/cli | sh' },
        ],
        windows: [
          { method: 'npm', command: 'npm install -g droid' },
          { method: 'powershell', command: 'irm https://app.factory.ai/cli/windows | iex' },
        ],
      },
      updates: {
        kind: 'supported',
        releaseSource: { kind: 'none' },
        update: { kind: 'package-manager' },
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
