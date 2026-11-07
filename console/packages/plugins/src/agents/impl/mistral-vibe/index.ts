import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

const install = [
  {
    method: 'other' as const,
    label: 'uv (required)',
    command: 'uv tool install --python 3.12 mistral-vibe',
    updateCommand: 'uv tool upgrade mistral-vibe',
    recommended: true,
  },
];

export const plugin = definePlugin(
  {
    id: 'mistral-vibe',
    name: 'Mistral Vibe',
    description: "Mistral's coding agent, using its native ACP server.",
    websiteUrl: 'https://docs.mistral.ai/vibe/code/cli/install-setup',
  },
  {
    autoApprove: { kind: 'supported' },
    effort: { kind: 'none' },
    hostDependency: {
      id: 'mistral-vibe',
      binaryNames: ['vibe-acp'],
      installDocs: 'https://docs.mistral.ai/vibe/code/cli/install-setup',
      installCommands: { macos: install, linux: install, windows: install },
      updates: {
        kind: 'supported',
        releaseSource: { kind: 'github', repo: 'mistralai/mistral-vibe' },
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
      throw new Error('Mistral Vibe runs through the ACP session host.');
    },
  },
});
