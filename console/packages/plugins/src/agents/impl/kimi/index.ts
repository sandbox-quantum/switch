import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

const KIMI_PACKAGE = '@moonshot-ai/kimi-code';
const NPM_INSTALL = {
  method: 'npm',
  command: `npm install -g ${KIMI_PACKAGE}`,
} as const;

export const plugin = definePlugin(
  {
    id: 'kimi',
    name: 'Kimi Code',
    description:
      "Moonshot AI's Kimi Code CLI over ACP, with approvals, questions and persistent conversations.",
    websiteUrl: 'https://moonshotai.github.io/kimi-code/en/guides/ides',
    cliLabel: 'Kimi Code CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'kimi',
      binaryNames: ['kimi'],
      installDocs: 'https://moonshotai.github.io/kimi-code/en/guides/getting-started',
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
            recommended: true,
          },
          NPM_INSTALL,
        ],
        linux: [
          {
            method: 'curl',
            command: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
            recommended: true,
          },
          NPM_INSTALL,
        ],
        windows: [
          {
            method: 'powershell',
            command:
              'powershell -ExecutionPolicy ByPass -c "irm https://code.kimi.com/kimi-code/install.ps1 | iex"',
            recommended: true,
          },
          NPM_INSTALL,
        ],
      },
      updates: {
        kind: 'supported',
        releaseSource: {
          kind: 'npm',
          package: KIMI_PACKAGE,
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
      throw new Error('Kimi Code CLI runs through the ACP session host.');
    },
  },
});
