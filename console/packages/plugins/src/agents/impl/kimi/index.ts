import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

const KIMI_INSTALL_SCRIPT = 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash';

export const plugin = definePlugin(
  {
    id: 'kimi',
    name: 'Kimi Code',
    description: "Moonshot AI's coding agent, for Kimi and other compatible models.",
    websiteUrl: 'https://moonshotai.github.io/kimi-code/en/',
    cliLabel: 'Kimi Code CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    // The script installs a single binary; npm needs Node.js 24.
    hostDependency: npmDependency({
      id: 'kimi',
      package: '@moonshot-ai/kimi-code',
      binaryNames: ['kimi'],
      recommended: false,
      extraOptions: {
        macos: [{ method: 'curl', command: KIMI_INSTALL_SCRIPT, recommended: true }],
        linux: [{ method: 'curl', command: KIMI_INSTALL_SCRIPT, recommended: true }],
        windows: [
          {
            method: 'powershell',
            command: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex',
            recommended: true,
          },
        ],
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
      throw new Error('Kimi Code runs through the ACP session host.');
    },
  },
});
