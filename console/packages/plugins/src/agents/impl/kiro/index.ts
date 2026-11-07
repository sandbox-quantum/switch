import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { passthroughMcpAdapter } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'kiro',
    name: 'Kiro CLI',
    description: 'Amazon Kiro CLI agent using the Agent Client Protocol (ACP).',
    websiteUrl: 'https://kiro.dev/',
    cliLabel: 'Kiro CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'kiro',
      binaryNames: ['kiro-cli'],
      installCommands: {},
      updates: { kind: 'none' },
    },
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
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
    repoAgents: {
      kind: 'none',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  prompt: {
    buildCommand: () => {
      throw new Error('Kiro CLI runs through the ACP session host.');
    },
  },
  mcp: passthroughMcpAdapter('.kiro/settings/mcp.json'),
});
