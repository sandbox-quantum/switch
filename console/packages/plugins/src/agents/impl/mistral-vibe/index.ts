import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'mistral-vibe',
    name: 'Mistral Vibe',
    description: "Mistral's open-source coding assistant.",
    websiteUrl: 'https://github.com/mistralai/mistral-vibe',
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
      binaryNames: ['vibe-acp'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash',
          },
        ],
        linux: [
          {
            method: 'curl',
            command: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash',
          },
        ],
        windows: [
          {
            method: 'other',
            label: 'uv',
            command: 'uv tool install mistral-vibe',
            updateCommand: 'uv tool install --upgrade mistral-vibe',
          },
        ],
      },
      updates: {
        kind: 'supported',
        releaseSource: {
          kind: 'github',
          repo: 'mistralai/mistral-vibe',
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
