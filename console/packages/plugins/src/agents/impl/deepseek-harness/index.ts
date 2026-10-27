import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'deepseek-harness',
    name: 'DeepSeek Harness',
    description:
      'DeepSeek Harness (dsh) ACP agent with API key authentication, approvals, and resumable conversations.',
    websiteUrl: 'https://github.com/deepseek-ai/deepseek-harness',
    cliLabel: 'DeepSeek Harness CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'deepseek-harness',
      binaryNames: ['dsh'],
      installCommands: {
        macos: [
          {
            method: 'npm',
            command: 'npm install -g @deepseek-ai/dsh',
          },
        ],
        linux: [
          {
            method: 'npm',
            command: 'npm install -g @deepseek-ai/dsh',
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
      throw new Error('DeepSeek Harness runs through the ACP session host.');
    },
  },
});
