import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'mistral-vibe',
    name: 'Mistral Vibe',
    description: 'Mistral Vibe minimal CLI coding agent with native ACP support.',
    websiteUrl: 'https://github.com/mistralai/mistral-vibe',
    cliLabel: 'Mistral Vibe CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'mistral-vibe',
      binaryNames: ['vibe-acp', 'vibe'],
      installCommands: {
        macos: [
          {
            method: 'pip',
            command: 'pip install mistral-vibe',
          },
        ],
        linux: [
          {
            method: 'pip',
            command: 'pip install mistral-vibe',
          },
        ],
        windows: [
          {
            method: 'pip',
            command: 'pip install mistral-vibe',
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
      throw new Error('Mistral Vibe runs through the ACP session host.');
    },
  },
});
