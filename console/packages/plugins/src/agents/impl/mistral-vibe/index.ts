import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

const install = { method: 'other' as const, command: 'uv tool install mistral-vibe' };

export const plugin = definePlugin(
  {
    id: 'mistral-vibe',
    name: 'Mistral Vibe',
    description: "Mistral's coding agent with native ACP approvals and persistent conversations.",
    websiteUrl: 'https://docs.mistral.ai/vibe/code/cli/install-setup',
    cliLabel: 'Mistral Vibe ACP',
  },
  {
    autoApprove: { kind: 'supported' },
    effort: { kind: 'none' },
    hostDependency: {
      id: 'mistral-vibe',
      binaryNames: ['vibe-acp'],
      installCommands: { macos: [install], linux: [install], windows: [install] },
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
      throw new Error('Mistral Vibe runs through the ACP session host.');
    },
  },
});
