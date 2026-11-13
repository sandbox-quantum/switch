import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

const INSTALL_SCRIPT = 'curl -fsSL https://x.ai/cli/install.sh | bash';

export const plugin = definePlugin(
  {
    id: 'grok',
    name: 'Grok Build',
    description: "xAI's open-source coding agent, for Grok models.",
    websiteUrl: 'https://x.ai/cli',
    cliLabel: 'Grok Build CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: npmDependency({
      id: 'grok',
      package: '@xai-official/grok',
      binaryNames: ['grok'],
      recommended: false,
      extraOptions: {
        macos: [{ method: 'curl', command: INSTALL_SCRIPT, recommended: true }],
        linux: [{ method: 'curl', command: INSTALL_SCRIPT, recommended: true }],
      },
    }),
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
