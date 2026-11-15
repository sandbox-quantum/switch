import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

const MISTRAL_VIBE_INSTALL_COMMAND = 'curl -LsSf https://mistral.ai/vibe/install.sh | bash';

export const plugin = definePlugin(
  {
    id: 'mistral-vibe',
    name: 'Mistral Vibe',
    description:
      "Mistral's coding agent CLI over ACP, with approvals, model choice and resumable conversations.",
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
            command: MISTRAL_VIBE_INSTALL_COMMAND,
          },
        ],
        linux: [
          {
            method: 'curl',
            command: MISTRAL_VIBE_INSTALL_COMMAND,
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
