import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const QWEN_INSTALL_UNIX = 'npm install -g @qwen-lm/qwen-code';

export const plugin = definePlugin(
  {
    id: 'qwen',
    name: 'Qwen Code',
    description:
      "Alibaba's open-source coding agent CLI with native ACP support and Qwen models.",
    websiteUrl: 'https://github.com/QwenLM/qwen-code',
    cliLabel: 'Qwen Code CLI (qwen)',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'qwen',
      binaryNames: ['qwen', 'qwen-code'],
      installDocs: 'https://github.com/QwenLM/qwen-code#installation',
      installCommands: {
        macos: [{ method: 'npm', command: QWEN_INSTALL_UNIX, recommended: true }],
        linux: [{ method: 'npm', command: QWEN_INSTALL_UNIX, recommended: true }],
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
      throw new Error('Qwen Code runs through the ACP session host.');
    },
  },
});
