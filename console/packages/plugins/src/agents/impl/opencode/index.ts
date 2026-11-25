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
 * OpenCode, from its `@opencode/cli` package.
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
 *
 * OpenCode 2 replaced OpenCode 1's `opencode-ai` package, which owns the same
 * `opencode` command, so npm will not install it over 1.x: updating 1.x
 * removes it first, and puts the same version back if OpenCode 2 does not
 * install. Sign-ins, settings and saved sessions carry over, since OpenCode 2
 * reads what 1.x left, except the sessions 1.x kept in its own database once
 * OpenCode Desktop 2 had migrated the shared one (`opencodeV1DatabasePath`):
 * OpenCode 2 migrates only the shared database, once.
 */
export const OPENCODE_PACKAGE = '@opencode/cli';
export const OPENCODE_1_PACKAGE = 'opencode-ai';
export const OPENCODE_2 = '2.0.0';

export const OPENCODE_2_SUMMARY =
  'Your settings, sign-ins and most sessions carry over. Running sessions stay on this version until they restart. If the upgrade fails, this version is put back.';

/**
 * Windows will not delete or replace a program while it runs, so neither npm
 * nor the release install can remove 1.x while any OpenCode is open: a session
 * in Console or OpenCode in a terminal. The check fails when one is running,
 * and the upgrade then changes nothing. Written without `$` or `%`, since the
 * install shell may be PowerShell or cmd.exe.
 */
export const OPENCODE_WINDOWS_PRECHECK = {
  command:
    'powershell -NoProfile -Command "if (Get-Process -Name opencode -ErrorAction SilentlyContinue) { exit 1 }"',
  blockedMessage: 'Close OpenCode and stop its agents, then try again. Nothing was changed.',
};

/** Where the npm package's latest version is read, as the Windows install reads it. */
export const OPENCODE_LATEST_URL = `https://registry.npmjs.org/${OPENCODE_PACKAGE}/latest`;

/**
 * The Windows release zip of `version`. The install passes a PowerShell
 * expression wrapped in `' + … + '`, so the address is finished at run time.
 */
export function opencodeWindowsReleaseUrl(version: string): string {
  return `https://github.com/anomalyco/opencode/releases/download/v${version}/opencode-windows-x64.zip`;
}

/**
 * Downloads and unpacks the release `version` names, a PowerShell expression,
 * then adds its folder to the user's PATH. Written without `$`, `%` or double
 * quotes inside, so it runs the same from cmd.exe and from PowerShell.
 */
export function opencodeWindowsInstall(version: string): string {
  return [
    'powershell -ExecutionPolicy ByPass -c "',
    "[Net.ServicePointManager]::SecurityProtocol = 'Tls12';",
    `(New-Object Net.WebClient).DownloadFile(('${opencodeWindowsReleaseUrl(`' + ${version} + '`)}'), [IO.Path]::Combine([IO.Path]::GetTempPath(), 'opencode-windows-x64.zip'));`,
    "Expand-Archive -Force ([IO.Path]::Combine([IO.Path]::GetTempPath(), 'opencode-windows-x64.zip')) ([IO.Path]::Combine([Environment]::GetFolderPath('UserProfile'), '.opencode', 'bin'));",
    `${addToUserPath('.opencode', 'bin')}"`,
  ].join(' ');
}

/**
 * The release of the npm package's latest version, which is what an update is
 * checked against. Not GitHub's latest release: OpenCode still publishes 1.x
 * releases, and the newest of them can be the latest there.
 */
export const OPENCODE_WINDOWS_INSTALL = opencodeWindowsInstall(
  `(Invoke-RestMethod '${OPENCODE_LATEST_URL}').version`
);

/** Removes what the release install unpacked, and nothing else. */
export const OPENCODE_WINDOWS_UNINSTALL = `powershell -ExecutionPolicy ByPass -c "${removeFromProfile('.opencode', 'bin')}"`;

const OPENCODE_HOST_DEPENDENCY = (() => {
  const base = npmDependency({ id: 'opencode', package: OPENCODE_PACKAGE });

  // Uninstall also removes `opencode-ai`, OpenCode 1's package; npm skips
  // whichever isn't present. A restore removes whatever of OpenCode 2 a failed
  // install left first, since npm refuses to put `opencode-ai` over it.
  const patchNpm = (
    options: typeof base.installCommands.macos,
    precheck: typeof OPENCODE_WINDOWS_PRECHECK | undefined,
    chain: (commands: string) => string
  ) =>
    options?.map((opt) => ({
      ...opt,
      ...(opt.uninstallCommand
        ? { uninstallCommand: `${opt.uninstallCommand} ${OPENCODE_1_PACKAGE}` }
        : {}),
      ...(opt.method === 'npm'
        ? {
            lineMigration: {
              below: OPENCODE_2,
              removeCommand: `npm uninstall -g ${OPENCODE_1_PACKAGE}`,
              restoreCommand: chain(
                `npm uninstall -g ${OPENCODE_PACKAGE} && npm install -g ${OPENCODE_1_PACKAGE}@{version}`
              ),
              summary: OPENCODE_2_SUMMARY,
              ...(precheck ? { precheck } : {}),
            },
          }
        : {}),
    }));

  // Through `cmd /c`, because the install shell may be Windows PowerShell 5.1,
  // where `&&` does not parse.
  const windowsNpm = (
    patchNpm(
      base.installCommands.windows,
      OPENCODE_WINDOWS_PRECHECK,
      (commands) => `cmd /c "${commands}"`
    ) ?? []
  ).map(({ recommended: _recommended, ...option }) => option);

  return {
    ...base,
    installCommands: {
      macos: patchNpm(base.installCommands.macos, undefined, (commands) => commands),
      windows: [
        {
          method: 'powershell' as const,
          label: 'OpenCode release',
          command: OPENCODE_WINDOWS_INSTALL,
          updateCommand: OPENCODE_WINDOWS_INSTALL,
          uninstallCommand: OPENCODE_WINDOWS_UNINSTALL,
          installedAt: ['.opencode\\bin\\'],
          recommended: true,
          // A 1.x release is replaced the same way as an npm install, so the
          // upgrade is offered and can be undone with the release it replaced.
          lineMigration: {
            below: OPENCODE_2,
            removeCommand: OPENCODE_WINDOWS_UNINSTALL,
            restoreCommand: opencodeWindowsInstall("'{version}'"),
            summary: OPENCODE_2_SUMMARY,
            precheck: OPENCODE_WINDOWS_PRECHECK,
          },
        },
        ...windowsNpm,
      ],
      linux: [
        {
          method: 'npm' as const,
          command: `npm install -g --prefix "$HOME/.local" ${OPENCODE_PACKAGE}`,
          uninstallCommand: `npm uninstall -g --prefix "$HOME/.local" ${OPENCODE_PACKAGE} ${OPENCODE_1_PACKAGE}`,
          installedAt: ['.local/lib/node_modules/'],
          recommended: true,
          // 1.x may sit in either prefix. Removing it from the system one needs
          // write access there; without it the upgrade stops before changing anything.
          lineMigration: {
            below: OPENCODE_2,
            removeCommand: `npm uninstall -g ${OPENCODE_1_PACKAGE} && npm uninstall -g --prefix "$HOME/.local" ${OPENCODE_1_PACKAGE}`,
            restoreCommand: `npm uninstall -g --prefix "$HOME/.local" ${OPENCODE_PACKAGE} && npm install -g --prefix "$HOME/.local" ${OPENCODE_1_PACKAGE}@{version}`,
            summary: OPENCODE_2_SUMMARY,
          },
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
