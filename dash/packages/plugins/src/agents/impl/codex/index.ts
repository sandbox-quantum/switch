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
import { codexLaunchProfile, codexProfilePaths } from './profile';

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
      supportedEvents: ['notification', 'stop', 'session'],
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
        // Approvals only — the sandbox is left to the user's config. "Bypass
        // permissions" promises unattended approval, not unattended filesystem
        // and network access, and Codex runs hooks outside the sandbox, so
        // switchdash's loopback curls reach the hook server under
        // workspace-write just as they do under danger-full-access.
        autoApproveFlag: '-c approval_policy="never"',
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
    launchProfilePaths: codexProfilePaths,
  },
});
