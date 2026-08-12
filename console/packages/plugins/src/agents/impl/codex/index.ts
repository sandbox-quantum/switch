import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import {
  buildStandardCommand,
  codexMcpAdapter,
  homebrewOption,
  npmDependency,
} from '@switch-console/core/agents/plugins/helpers';
import type { HostDependencyDescriptor, InstallOption } from '@switch-console/core/deps';
import { SWITCH_MARKETPLACE_SOURCE } from '../../../distribution';
import { buildCodexHookConfig, CODEX_HOOK_TRUST_FLAG } from './hooks';
import { icon } from './icon';
import { codexLaunchProfile, codexProfilePaths } from './profile';

const CODEX_WINDOWS_INSTALL_SCRIPT =
  'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"';

/**
 * Undo what `install.ps1` created, and nothing else.
 *
 * The script has no uninstaller and Codex has no `uninstall` subcommand, but
 * its footprint is exactly two directories: the standalone releases under
 * `%USERPROFILE%\.codex\packages\standalone`, and a junction to the current one
 * under `%LOCALAPPDATA%\Programs\OpenAI\Codex`. The rest of `~/.codex` — config,
 * auth, sessions, hooks — is the user's and is deliberately left alone, as is
 * the PATH entry, which points at a directory that no longer exists.
 *
 * Written without `$` or `%` so it survives both shells a Windows user can have
 * resolved for install commands: PowerShell would interpolate `$env:...` before
 * `powershell -c` ever saw it, and cmd.exe would expand `%LOCALAPPDATA%`.
 */
const CODEX_WINDOWS_UNINSTALL_SCRIPT =
  'powershell -ExecutionPolicy ByPass -c "' +
  "Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\\OpenAI\\Codex') -Recurse -Force -ErrorAction SilentlyContinue; " +
  "Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\\packages\\standalone') -Recurse -Force -ErrorAction SilentlyContinue" +
  '"';

/**
 * The official Windows install path is the ChatGPT script, not a global npm
 * package, so it leads and carries the Recommended badge.
 *
 * `npmDependency` flags its own option as recommended for every platform, and
 * both consumers — `pickInstallOption` and the settings UI's `seedSource` —
 * take the *first* recommended option. Leaving the flag on npm would keep
 * steering Windows users there however this list is ordered, so it is dropped
 * on this platform only.
 */
function codexHostDependency(): HostDependencyDescriptor {
  const descriptor = npmDependency({
    id: 'codex',
    package: '@openai/codex',
    extraOptions: {
      macos: [homebrewOption({ formula: 'codex', cask: true })],
      linux: [homebrewOption({ formula: 'codex', cask: true })],
    },
  });
  const windowsNative: InstallOption = {
    method: 'powershell',
    command: CODEX_WINDOWS_INSTALL_SCRIPT,
    updateCommand: CODEX_WINDOWS_INSTALL_SCRIPT,
    uninstallCommand: CODEX_WINDOWS_UNINSTALL_SCRIPT,
    recommended: true,
  };
  const windowsNpm = (descriptor.installCommands.windows ?? []).map(
    ({ recommended: _recommended, ...option }) => option
  );
  return {
    ...descriptor,
    installCommands: {
      ...descriptor.installCommands,
      windows: [windowsNative, ...windowsNpm],
    },
  };
}

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
      supportedEvents: ['notification', 'stop', 'session', 'tool-use', 'tool-done'],
    },
    hostDependency: codexHostDependency(),
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
        // Switch Console's loopback curls reach the hook server under
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
    // The profile carries per-agent model / effort / instructions in CODEX_HOME,
    // loaded with `--profile <slug>`. It registers no MCP server: the connector
    // plugin's own .mcp.json does that, for every Codex session rather than only
    // Switch Console's.
    launchProfile: codexLaunchProfile,
    launchProfilePaths: codexProfilePaths,
  },
});
