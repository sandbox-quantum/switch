import { definePlugin, registerPluginBehavior } from '@switchdash/core/agents/plugins';
import {
  buildStandardCommand,
  codexMcpAdapter,
  homebrewOption,
  npmDependency,
} from '@switchdash/core/agents/plugins/helpers';
import { SWITCH_MARKETPLACE_SOURCE } from '../../../distribution';
import { buildCodexAutoApproveFlag, CODEX_HOOK_TRUST_FLAG } from './auto-approve';
import { buildCodexHookConfig } from './hooks';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'codex',
    name: 'Codex',
    description:
      'CLI that connects to OpenAI models for project-aware code assistance and terminal workflows.',
    websiteUrl: 'https://github.com/openai/codex',
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
      supportedEvents: ['notification', 'stop', 'session', 'tool-done'],
    },
    hostDependency: npmDependency({
      id: 'codex',
      package: '@openai/codex',
      extraOptions: {
        macos: [homebrewOption({ formula: 'codex', cask: true })],
        linux: [homebrewOption({ formula: 'codex', cask: true })],
        windows: [
          {
            method: 'powershell',
            command:
              'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
            updateCommand:
              'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
          },
        ],
      },
    }),
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
    switchSetup: {
      kind: 'cli',
      pluginName: 'switch-connector-codex',
      marketplaceName: 'switch-plugins',
      marketplaceSource: SWITCH_MARKETPLACE_SOURCE,
      // Codex has no install-scope flag; the value is unused for this dialect.
      scope: 'user',
      dialect: 'codex',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        // Every session, not just auto-approving ones: Codex runs no hook it has
        // no persisted trust entry for, and switchdash's room tracking and
        // rollout-id capture are hooks.
        defaultArgs: [CODEX_HOOK_TRUST_FLAG],
        // Resolved only when it will actually be used: an unrecognised
        // CODEX_SANDBOX_MODE is a hard error, and a session that never
        // auto-approves has no business failing to launch over it.
        autoApproveFlag: ctx.autoApprove ? buildCodexAutoApproveFlag(process.env) : '',
        initialPromptFlag: '',
        resumeFlag: 'resume',
        sessionIdFlag: ' ',
        sessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: 'resume --last',
        deduplicateFlags: ['--dangerously-bypass-approvals-and-sandbox'],
      }),
  },
  hooks: buildCodexHookConfig(),
  mcp: codexMcpAdapter(),
});
