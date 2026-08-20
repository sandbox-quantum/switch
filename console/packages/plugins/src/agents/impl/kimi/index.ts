import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import type { AgentCommand, CommandContext } from '@switch-console/core/agents/plugins';
import { buildStandardCommand } from '@switch-console/core/agents/plugins/helpers';
import { addKimiHooksToConfigText, buildKimiHookConfig } from './hooks';

/**
 * The inline `--config` value is built from argv, and `CommandContext` does not
 * say which host the argv will run on, so this path can only assume the
 * console's platform. A remote Kimi session therefore still gets the console's
 * hook dialect; the config-file path (`writeHooks`) is the one that knows the
 * target platform.
 */
function injectKimiHooksIntoInlineConfig(args: string[]): string[] {
  const opts = { platform: process.platform };
  return args.map((arg, index) => {
    if (arg === '--config' && args[index + 1] !== undefined) return arg;
    if (index > 0 && args[index - 1] === '--config') return addKimiHooksToConfigText(arg, opts);
    if (arg.startsWith('--config='))
      return `--config=${addKimiHooksToConfigText(arg.slice('--config='.length), opts)}`;
    return arg;
  });
}

function buildKimiCommand(ctx: CommandContext): AgentCommand {
  const cmd = buildStandardCommand(ctx, {
    autoApproveFlag: '--yolo',
    resumeFlag: '-S',
    sessionIdFlag: '-S',
    sessionIdOnResumeOnly: true,
    resumeWithoutSessionFlag: '-C',
    omitAutoApproveOnResume: true,
  });
  return { ...cmd, args: injectKimiHooksIntoInlineConfig(cmd.args) };
}
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'kimi',
    name: 'Kimi',
    description:
      'Kimi CLI by Moonshot AI, with shell execution, Zsh integration, ACP, and MCP support.',
    websiteUrl: 'https://moonshotai.github.io/kimi-cli/en/guides/getting-started.html',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hooks: {
      kind: 'config',
      scope: 'global',
      supportedEvents: ['notification', 'stop', 'session', 'start'],
      reportsSessionStart: false,
    },
    hostDependency: {
      id: 'kimi',
      binaryNames: ['kimi'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: 'curl -LsSf https://code.kimi.com/install.sh | bash',
          },
        ],
        linux: [
          {
            method: 'curl',
            command: 'curl -LsSf https://code.kimi.com/install.sh | bash',
          },
        ],
      },
      updates: {
        kind: 'supported',
        releaseSource: {
          kind: 'github',
          repo: 'moonshotai/kimi-cli',
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
      kind: 'keystroke',
    },
    sessions: {
      kind: 'resumable',
    },
    repoAgents: { kind: 'none' },
    switchSetup: { kind: 'none' },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  prompt: {
    buildCommand: buildKimiCommand,
  },
  hooks: buildKimiHookConfig(),
  sessions: {
    validateSessionId: undefined,
  },
});
