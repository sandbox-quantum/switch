import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

const KIMI_CODE_INSTALL_COMMAND = 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash';

export const plugin = definePlugin(
  {
    id: 'kimi-code',
    name: 'Kimi Code',
    description:
      "Moonshot AI's coding agent CLI over ACP, with approvals, questions, model choice and resumable conversations.",
    websiteUrl: 'https://moonshotai.github.io/kimi-code/en/',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'kimi-code',
      binaryNames: ['kimi'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: KIMI_CODE_INSTALL_COMMAND,
          },
        ],
        linux: [
          {
            method: 'curl',
            command: KIMI_CODE_INSTALL_COMMAND,
          },
        ],
        windows: [
          {
            method: 'powershell',
            command:
              'powershell -ExecutionPolicy ByPass -c "irm https://code.kimi.com/kimi-code/install.ps1 | iex"',
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
      throw new Error('Kimi Code runs through the ACP session host.');
    },
  },
});
