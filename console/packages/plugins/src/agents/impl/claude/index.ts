import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import {
  buildStandardCommand,
  homebrewOption,
  passthroughMcpAdapter,
} from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';
import { CLAUDE_SUBAGENTS, claudeRepoAgentsBehavior } from './subagents';

/**
 * Anthropic's documented Windows installer, wrapped in `powershell -c` so it
 * runs whichever shell the install runner resolved: cmd.exe, Windows
 * PowerShell 5.1 (where `&&` does not parse and `curl` is an alias) or Git
 * Bash. Kept free of `$` and `%` so neither shell expands anything first.
 */
const CLAUDE_WINDOWS_INSTALL_SCRIPT =
  'powershell -ExecutionPolicy ByPass -c "irm https://claude.ai/install.ps1 | iex"';

export const plugin = definePlugin(
  {
    id: 'claude',
    name: 'Claude Code',
    description:
      'CLI that uses Anthropic Claude for code edits, explanations, and structured refactors in the terminal.',
    websiteUrl: 'https://code.claude.com/docs/en/quickstart',
    knownAgentType: 'claude-code',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'claude',
      binaryNames: ['claude'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: 'curl -fsSL https://claude.ai/install.sh | bash',
            uninstallCommand: 'claude uninstall',
            recommended: true,
          },
          homebrewOption({ formula: 'claude-code', cask: true }),
        ],
        linux: [
          {
            method: 'curl',
            command: 'curl -fsSL https://claude.ai/install.sh | bash',
            uninstallCommand: 'claude uninstall',
          },
        ],
        windows: [
          {
            method: 'powershell',
            command: CLAUDE_WINDOWS_INSTALL_SCRIPT,
            uninstallCommand: 'claude uninstall',
          },
        ],
      },
      updates: {
        kind: 'supported',
        releaseSource: {
          kind: 'github',
          repo: 'anthropics/claude-code',
        },
        update: {
          kind: 'cli',
          args: ['install', 'latest'],
        },
      },
      uninstall: {
        kind: 'package-manager',
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
    repoAgents: {
      kind: 'definitions',
      dirRelative: CLAUDE_SUBAGENTS.dirRelative,
      settingsSuffix: CLAUDE_SUBAGENTS.settingsSuffix,
      definitionsDirRelative: CLAUDE_SUBAGENTS.definitionsDirRelative,
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag: '--dangerously-skip-permissions',
        autoModeFlag: '--permission-mode auto',
        initialPromptFlag: '',
        resumeFlag: '--resume',
        sessionIdFlag: '--session-id',
      }),
  },
  mcp: passthroughMcpAdapter('.claude.json'),
  repoAgents: claudeRepoAgentsBehavior,
});
