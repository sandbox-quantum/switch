import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import {
  buildStandardCommand,
  npmDependency,
  opencodeMcpAdapter,
} from '@switch-console/core/agents/plugins/helpers';
import { addToUserPath, removeFromProfile } from '../windows-user-path';
import { icon } from './icon';
import { opencodeLaunchProfileModels } from './models';
import {
  opencodeLaunchProfile,
  opencodeLaunchProfileSettings,
  opencodeProfilePaths,
} from './profile';

const validateSessionId = (id: string) => id.startsWith('ses');

/**
 * OpenCode 1, from its `opencode-ai` package. OpenCode 2 is published as
 * `@opencode/cli` and serves an API Switch does not speak yet, so installing
 * it would give a CLI whose sign-in can never be checked.
 *
 * On Linux it goes into the user prefix: npm's default global prefix there is
 * a system directory, so `npm install -g` needs root, which the user a remote
 * agent runs as typically does not have. `$HOME/.local/bin` is already on the
 * PATH Switch Console captures for a remote host. macOS and Windows keep the
 * plain global install: their default prefixes are user-writable.
 *
 * Windows also offers OpenCode's own build, first, because a fresh Windows
 * has no Node and so no npm: the release zip, unpacked into
 * `~\.opencode\bin`, which is added to the user's PATH.
 */
export const OPENCODE_PACKAGE = 'opencode-ai';

/** The newest OpenCode 1 release, the last one Switch's OpenCode session speaks to. */
export const OPENCODE_WINDOWS_RELEASE = 'v1.19.5';

/**
 * Downloads and unpacks the release, then adds its folder to the user's PATH.
 * Written without `$`, `%` or double quotes inside, so it runs the same from
 * cmd.exe and from PowerShell.
 */
export const OPENCODE_WINDOWS_INSTALL = [
  'powershell -ExecutionPolicy ByPass -c "',
  "[Net.ServicePointManager]::SecurityProtocol = 'Tls12';",
  `(New-Object Net.WebClient).DownloadFile('https://github.com/anomalyco/opencode/releases/download/${OPENCODE_WINDOWS_RELEASE}/opencode-windows-x64.zip', [IO.Path]::Combine([IO.Path]::GetTempPath(), 'opencode-windows-x64.zip'));`,
  "Expand-Archive -Force ([IO.Path]::Combine([IO.Path]::GetTempPath(), 'opencode-windows-x64.zip')) ([IO.Path]::Combine([Environment]::GetFolderPath('UserProfile'), '.opencode', 'bin'));",
  `${addToUserPath('.opencode', 'bin')}"`,
].join(' ');

/** Removes what the release install unpacked, and nothing else. */
export const OPENCODE_WINDOWS_UNINSTALL = `powershell -ExecutionPolicy ByPass -c "${removeFromProfile('.opencode', 'bin')}"`;

const OPENCODE_HOST_DEPENDENCY = (() => {
  const base = npmDependency({ id: 'opencode', package: OPENCODE_PACKAGE });

  // Uninstall also removes `@opencode/cli`, which Console installed for a
  // while; npm skips whichever isn't present.
  const patchUninstall = (options: typeof base.installCommands.macos) =>
    options?.map((opt) => ({
      ...opt,
      ...(opt.uninstallCommand
        ? { uninstallCommand: `${opt.uninstallCommand} @opencode/cli` }
        : {}),
    }));

  const windowsNpm = (patchUninstall(base.installCommands.windows) ?? []).map(
    ({ recommended: _recommended, ...option }) => option
  );

  return {
    ...base,
    installCommands: {
      macos: patchUninstall(base.installCommands.macos),
      windows: [
        {
          method: 'powershell' as const,
          label: 'OpenCode release',
          command: OPENCODE_WINDOWS_INSTALL,
          updateCommand: OPENCODE_WINDOWS_INSTALL,
          uninstallCommand: OPENCODE_WINDOWS_UNINSTALL,
          installedAt: ['.opencode\\bin\\'],
          recommended: true,
        },
        ...windowsNpm,
      ],
      linux: [
        {
          method: 'npm' as const,
          command: `npm install -g --prefix "$HOME/.local" ${OPENCODE_PACKAGE}`,
          uninstallCommand: `npm uninstall -g --prefix "$HOME/.local" ${OPENCODE_PACKAGE} @opencode/cli`,
          recommended: true,
        },
      ],
    },
  };
})();

export const plugin = definePlugin(
  {
    id: 'opencode',
    name: 'OpenCode',
    description:
      'OpenCode CLI that interfaces with models for code generation and edits from the shell.',
    websiteUrl: 'https://opencode.ai/docs/cli/',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: OPENCODE_HOST_DEPENDENCY,
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
      flag: '--prompt',
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
        extraEnv: ctx.autoApprove ? { OPENCODE_PERMISSION: '{"*":"allow"}' } : {},
        // Approves every ask but keeps what the person's own config denies.
        autoModeFlag: '--auto',
        initialPromptFlag: '--prompt',
        resumeFlag: '--session',
        sessionIdFlag: '--session',
        sessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: '--continue',
        validateSessionId,
      }),
  },
  sessions: { validateSessionId },
  mcp: {
    ...opencodeMcpAdapter(),
    // The profile carries per-agent model / variant / sampling / instructions in
    // a config file under `~/.config/opencode/switch`, loaded with
    // `OPENCODE_CONFIG` because OpenCode has no flag that would load it. It
    // registers no MCP server: the session host supplies the Switch one to each
    // session it starts.
    launchProfile: opencodeLaunchProfile,
    launchProfilePaths: opencodeProfilePaths,
    launchProfileSettings: opencodeLaunchProfileSettings,
    // A variant is whatever the chosen model declares, so the only correct list
    // is the one the installed OpenCode reports. Asking also lets a typed model
    // be checked, which matters because OpenCode accepts an unknown one in
    // silence and only fails when the agent tries to answer.
    launchProfileModels: opencodeLaunchProfileModels,
  },
});
