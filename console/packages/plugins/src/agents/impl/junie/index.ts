import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

const INSTALL_COMMAND = 'curl -fsSL https://junie.jetbrains.com/install.sh | bash';

export const plugin = definePlugin(
  {
    id: 'junie',
    name: 'Junie',
    description:
      "JetBrains' coding agent, run over ACP with approvals and resumable conversations.",
    websiteUrl: 'https://junie.jetbrains.com/docs/junie-cli.html',
    cliLabel: 'Junie CLI',
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
      installCommands: {
        macos: [{ method: 'curl', command: INSTALL_COMMAND }],
        linux: [{ method: 'curl', command: INSTALL_COMMAND }],
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
