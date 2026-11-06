import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const VIBE_INSTALL_UNIX = 'pip install mistral-vibe';

export const plugin = definePlugin(
  {
    id: 'mistral-vibe',
    name: 'Mistral Vibe',
    description:
      "Mistral's open-source coding agent CLI with native ACP support and Mistral models.",
    websiteUrl: 'https://github.com/mistralai/mistral-vibe',
    cliLabel: 'Mistral Vibe CLI (vibe)',
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
      binaryNames: ['vibe', 'vibe-acp'],
      installDocs: 'https://github.com/mistralai/mistral-vibe#installation',
      installCommands: {
        macos: [{ method: 'pip', command: VIBE_INSTALL_UNIX, recommended: true }],
        linux: [{ method: 'pip', command: VIBE_INSTALL_UNIX, recommended: true }],
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
