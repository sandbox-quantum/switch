import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const GROK_BUILD_INSTALL_DOCS = 'https://x.ai';

export const plugin = definePlugin(
  {
    id: 'grok-build',
    name: 'Grok Build',
    description: "xAI's Grok Build coding agent over the Agent Client Protocol.",
    websiteUrl: GROK_BUILD_INSTALL_DOCS,
    cliLabel: 'Grok Build CLI',
  },
  {
    autoApprove: { kind: 'supported' },
    effort: { kind: 'none' },
    hostDependency: npmDependency({
      id: 'grok-build',
      package: '@xai-official/grok',
      binaryNames: ['grok'],
      installDocs: GROK_BUILD_INSTALL_DOCS,
    }),
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
      throw new Error('Grok Build runs through the ACP session host.');
    },
  },
});
