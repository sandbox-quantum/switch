import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

/** Mistral's installer, which installs Vibe with uv; `vibe-acp` comes with it. */
export const VIBE_INSTALL_UNIX = 'curl -LsSf https://mistral.ai/vibe/install.sh | bash';

export const plugin = definePlugin(
  {
    id: 'mistral-vibe',
    name: 'Mistral Vibe',
    description:
      "Mistral's coding agent CLI over ACP, with its own approval modes, Mistral models and persistent conversations.",
    websiteUrl: 'https://github.com/mistralai/mistral-vibe',
    cliLabel: 'Mistral Vibe (vibe-acp)',
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
      installDocs: 'https://github.com/mistralai/mistral-vibe#installation',
      installCommands: {
        macos: [{ method: 'curl', command: VIBE_INSTALL_UNIX, recommended: true }],
        linux: [{ method: 'curl', command: VIBE_INSTALL_UNIX, recommended: true }],
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
