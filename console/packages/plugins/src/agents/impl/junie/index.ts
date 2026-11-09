import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const JUNIE_INSTALL_UNIX = 'npm install -g @jetbrains/junie';

export const plugin = definePlugin(
  {
    id: 'junie',
    name: 'Junie',
    description:
      "JetBrains' AI coding agent CLI with native ACP support and JetBrains models.",
    websiteUrl: 'https://www.jetbrains.com/junie/',
    cliLabel: 'Junie CLI (junie)',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'junie',
      binaryNames: ['junie'],
      installDocs: 'https://www.jetbrains.com/junie/docs/getting-started.html',
      installCommands: {
        macos: [{ method: 'npm', command: JUNIE_INSTALL_UNIX, recommended: true }],
        linux: [{ method: 'npm', command: JUNIE_INSTALL_UNIX, recommended: true }],
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
      throw new Error('Junie runs through the ACP session host.');
    },
  },
});
