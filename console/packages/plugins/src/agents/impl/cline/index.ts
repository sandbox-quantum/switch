import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'cline',
    name: 'Cline',
    description:
      'Autonomous coding agent right in your terminal that speaks the Agent Client Protocol.',
    websiteUrl: 'https://github.com/cline/cline',
    cliLabel: 'Cline CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'cline',
      binaryNames: ['cline'],
      installCommands: {
        macos: [
          {
            method: 'npm',
            command: 'npm i -g cline',
          },
        ],
        linux: [
          {
            method: 'npm',
            command: 'npm i -g cline',
          },
        ],
        windows: [
          {
            method: 'npm',
            command: 'npm i -g cline',
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
      throw new Error('Cline runs through the ACP session host.');
    },
  },
});
