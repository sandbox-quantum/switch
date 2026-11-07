import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'openhands',
    name: 'OpenHands',
    description: "OpenHands' coding agent CLI over ACP, running the model set in its own settings.",
    websiteUrl: 'https://docs.openhands.dev/openhands/usage/cli/quick-start',
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
            method: 'other',
            label: 'uv',
            command: 'uv tool install openhands --python 3.12',
            updateCommand: 'uv tool upgrade openhands',
          },
        ],
        linux: [
          {
            method: 'other',
            label: 'uv',
            command: 'uv tool install openhands --python 3.12',
            updateCommand: 'uv tool upgrade openhands',
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
