import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const GROK_INSTALL_UNIX = 'npm install -g @xai/grok-build';

export const plugin = definePlugin(
  {
    id: 'grok',
    name: 'Grok Build',
    description:
      "xAI's open-source coding agent CLI with native ACP support and Grok models.",
    websiteUrl: 'https://x.ai',
    cliLabel: 'Grok Build CLI (grok)',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'grok',
      binaryNames: ['grok', 'grok-build'],
      installDocs: 'https://x.ai/grok-build#installation',
      installCommands: {
        macos: [{ method: 'npm', command: GROK_INSTALL_UNIX, recommended: true }],
        linux: [{ method: 'npm', command: GROK_INSTALL_UNIX, recommended: true }],
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
      throw new Error('Grok Build runs through the ACP session host.');
    },
  },
});
