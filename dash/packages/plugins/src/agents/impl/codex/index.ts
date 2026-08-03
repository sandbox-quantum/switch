import { definePlugin, registerPluginBehavior } from '@switchdash/core/agents/plugins';
import {
  buildStandardCommand,
  codexMcpAdapter,
  homebrewOption,
  npmDependency,
} from '@switchdash/core/agents/plugins/helpers';
import { SWITCH_MARKETPLACE_SOURCE } from '../../../distribution';
import { buildCodexHookConfig, CODEX_HOOK_TRUST_FLAG } from './hooks';
import { icon } from './icon';
import { codexLaunchProfile } from './profile';

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
        // Every session, not just auto-approving ones. See the flag's docblock.
        defaultArgs: [CODEX_HOOK_TRUST_FLAG],
        // Deliberately overrides any sandbox_mode in the user's
        // ~/.codex/config.toml. Codex's own default, workspace-write, blocks
        // network access including loopback, and switchdash's hooks are curls
        // to 127.0.0.1 that end in `|| true` — under a sandbox they fail
        // silently, taking room tracking and rollout-id capture with them.
        autoApproveFlag: '-c approval_policy="never" -c sandbox_mode="danger-full-access"',
        initialPromptFlag: '',
        resumeFlag: 'resume',
        sessionIdFlag: ' ',
        sessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: 'resume --last',
        deduplicateFlags: ['--dangerously-bypass-approvals-and-sandbox'],
      }),
  },
  hooks: buildCodexHookConfig(),
  mcp: {
    ...codexMcpAdapter(),
    // Codex cannot expand ${VAR} in a bundled .mcp.json, so switchdash registers
    // the local Switch runtime itself: a per-agent profile in CODEX_HOME loaded
    // with `--profile <slug>`.
    launchProfile: codexLaunchProfile,
  },
});
