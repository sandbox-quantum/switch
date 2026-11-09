import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import {
  buildStandardCommand,
  cursorMcpAdapter,
} from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'pi',
    name: 'Pi',
    description:
      "Pi's coding agent CLI; lightweight, model-agnostic coding assistant supporting multiple LLM providers.",
    websiteUrl: 'https://github.com/badlogic/pi-mono',
    cliLabel: 'Pi CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'pi',
      binaryNames: ['pi', 'pi-acp'],
      installCommands: {
        macos: [
          {
            method: 'npm',
            command: 'npm install -g @badlogic/pi',
          },
        ],
        linux: [
          {
            method: 'npm',
            command: 'npm install -g @badlogic/pi',
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
      kind: 'argv',
      flag: '',
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
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag: '--auto-approve',
        initialPromptFlag: '',
        resumeFlag: '--resume',
      }),
  },
  mcp: {
    ...cursorMcpAdapter(),
    launchProfileSettings: () => ({}),
  },
});
